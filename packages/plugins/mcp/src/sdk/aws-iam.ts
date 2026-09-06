import { AwsV4Signer } from "aws4fetch";
import { XMLParser } from "fast-xml-parser";
import { Effect, Option, Schema } from "effect";
import { HttpClient, HttpClientRequest } from "effect/unstable/http";

export const AWS_IAM_AUTH_KIND = "aws_iam" as const;

const ACCESS_KEY_ID = "access_key_id";
const SECRET_ACCESS_KEY = "secret_access_key";
const SESSION_TOKEN = "session_token";
const ROLE_ARN = "role_arn";
const EXTERNAL_ID = "external_id";
const REFRESH_SKEW_MS = 60_000;

export class AwsIamAuthError extends Schema.TaggedErrorClass<AwsIamAuthError>()("AwsIamAuthError", {
  stage: Schema.Literals(["credentials", "assume_role", "identity", "token"]),
  message: Schema.String,
  httpStatus: Schema.optional(Schema.Number),
  awsCode: Schema.optional(Schema.String),
}) {}

type AwsCredentials = {
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly sessionToken?: string;
};

type AwsIamInput = {
  readonly bootstrap: AwsCredentials;
  readonly roleArn: string;
  readonly externalId?: string;
  readonly region: string;
  readonly expectedAccountId: string;
};

export type AwsIamResolvedToken = {
  readonly accessToken: string;
  readonly expiresAt: number;
  readonly accountId: string;
  readonly arn: string;
  /** Non-secret process-local generation used to rotate pooled MCP sessions. */
  readonly version: number;
};

const AwsRoleArn = /^arn:aws:iam::(\d{12}):role\/(.+)$/;
const AWS_MCP_REGIONS = new Map([
  ["aws-mcp.us-east-1.api.aws", "us-east-1"],
  ["aws-mcp.eu-central-1.api.aws", "eu-central-1"],
]);

/** The IAM-derived bearer is scoped to AWS MCP and must never be forwarded to
 * a user-controlled server. Keep this allowlist at the credential boundary. */
export const isManagedAwsMcpEndpoint = (endpoint: string): boolean => {
  if (!URL.canParse(endpoint)) return false;
  const url = new URL(endpoint);
  return (
    url.protocol === "https:" &&
    AWS_MCP_REGIONS.has(url.hostname) &&
    url.port === "" &&
    url.pathname === "/mcp" &&
    url.username === "" &&
    url.password === "" &&
    url.search === "" &&
    url.hash === ""
  );
};

const managedAwsMcpRegion = (endpoint: string): string | undefined => {
  if (!isManagedAwsMcpEndpoint(endpoint)) return undefined;
  return AWS_MCP_REGIONS.get(new URL(endpoint).hostname);
};

const requiredValue = (
  values: Record<string, string | null>,
  variable: string,
  label: string,
): Effect.Effect<string, AwsIamAuthError> => {
  const value = values[variable]?.trim();
  return value
    ? Effect.succeed(value)
    : Effect.fail(
        new AwsIamAuthError({
          stage: "credentials",
          message: `${label} is required for AWS IAM authentication`,
        }),
      );
};

export const parseAwsIamInput = Effect.fn("McpAwsIam.parseInput")(function* (
  values: Record<string, string | null>,
  region = "us-east-1",
) {
  const accessKeyId = yield* requiredValue(values, ACCESS_KEY_ID, "Access key ID");
  const secretAccessKey = yield* requiredValue(values, SECRET_ACCESS_KEY, "Secret access key");
  const roleArn = yield* requiredValue(values, ROLE_ARN, "Role ARN");
  const roleMatch = AwsRoleArn.exec(roleArn);
  if (!roleMatch) {
    return yield* new AwsIamAuthError({
      stage: "credentials",
      message: "Role ARN must identify an IAM role in an AWS account",
    });
  }
  const sessionToken = values[SESSION_TOKEN]?.trim() || undefined;
  const externalId = values[EXTERNAL_ID]?.trim() || undefined;
  return {
    bootstrap: {
      accessKeyId,
      secretAccessKey,
      ...(sessionToken ? { sessionToken } : {}),
    },
    roleArn,
    ...(externalId ? { externalId } : {}),
    region,
    expectedAccountId: roleMatch[1]!,
  } satisfies AwsIamInput;
});

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  parseTagValue: false,
  trimValues: true,
});

const StsCredentialsResponse = Schema.Struct({
  AssumeRoleResponse: Schema.Struct({
    AssumeRoleResult: Schema.Struct({
      Credentials: Schema.Struct({
        AccessKeyId: Schema.String,
        SecretAccessKey: Schema.String,
        SessionToken: Schema.String,
        Expiration: Schema.String,
      }),
    }),
  }),
});

const StsIdentityResponse = Schema.Struct({
  GetCallerIdentityResponse: Schema.Struct({
    GetCallerIdentityResult: Schema.Struct({
      Account: Schema.String,
      Arn: Schema.String,
    }),
  }),
});

const AwsErrorResponse = Schema.Struct({
  ErrorResponse: Schema.Struct({
    Error: Schema.Struct({
      Code: Schema.optional(Schema.String),
    }),
  }),
});

const TokenResponse = Schema.Struct({
  access_token: Schema.String,
  expires_in: Schema.Number,
  token_type: Schema.String,
});

const decodeStsCredentials = Schema.decodeUnknownEffect(StsCredentialsResponse);
const decodeStsIdentity = Schema.decodeUnknownEffect(StsIdentityResponse);
const decodeAwsError = Schema.decodeUnknownOption(AwsErrorResponse);
const decodeTokenResponse = Schema.decodeUnknownEffect(Schema.fromJsonString(TokenResponse));
const encodeJson = Schema.encodeUnknownSync(Schema.UnknownFromJsonString);

const parseXml = (
  text: string,
  stage: AwsIamAuthError["stage"],
): Effect.Effect<unknown, AwsIamAuthError> =>
  Effect.try({
    try: () => xmlParser.parse(text) as unknown,
    catch: () =>
      new AwsIamAuthError({
        stage,
        message: "AWS STS returned an unreadable response",
      }),
  });

const signedRequest = Effect.fn("McpAwsIam.signRequest")(function* (input: {
  readonly url: string;
  readonly service: string;
  readonly region: string;
  readonly credentials: AwsCredentials;
  readonly body: string;
  readonly contentType: string;
}) {
  const signed = yield* Effect.tryPromise({
    try: () =>
      new AwsV4Signer({
        method: "POST",
        url: input.url,
        headers: { "content-type": input.contentType },
        body: input.body,
        service: input.service,
        region: input.region,
        ...input.credentials,
      }).sign(),
    catch: () =>
      new AwsIamAuthError({
        stage: "credentials",
        message: "Could not sign the AWS authentication request",
      }),
  });
  const headers: Record<string, string> = {};
  signed.headers.forEach((value, name) => {
    headers[name] = value;
  });
  return HttpClientRequest.post(signed.url.toString()).pipe(
    HttpClientRequest.setHeaders(headers),
    HttpClientRequest.bodyText(input.body, input.contentType),
  );
});

const executeSigned = Effect.fn("McpAwsIam.executeSigned")(function* (input: {
  readonly stage: "assume_role" | "identity" | "token";
  readonly url: string;
  readonly service: string;
  readonly region: string;
  readonly credentials: AwsCredentials;
  readonly body: string;
  readonly contentType: string;
}) {
  const client = yield* HttpClient.HttpClient;
  const request = yield* signedRequest(input);
  const response = yield* client.execute(request).pipe(
    Effect.mapError(
      () =>
        new AwsIamAuthError({
          stage: input.stage,
          message: `Could not reach AWS during ${input.stage.replace("_", " ")}`,
        }),
    ),
  );
  const text = yield* response.text.pipe(
    Effect.mapError(
      () =>
        new AwsIamAuthError({
          stage: input.stage,
          message: `Could not read the AWS ${input.stage.replace("_", " ")} response`,
          httpStatus: response.status,
        }),
    ),
  );
  if (response.status >= 200 && response.status < 300) return text;

  const parsed = yield* parseXml(text, input.stage).pipe(Effect.option);
  const decoded = Option.flatMap(parsed, decodeAwsError);
  const awsCode = Option.getOrUndefined(
    Option.map(decoded, (value) => value.ErrorResponse.Error.Code),
  );
  return yield* new AwsIamAuthError({
    stage: input.stage,
    message: `AWS rejected ${input.stage.replace("_", " ")}`,
    httpStatus: response.status,
    ...(awsCode ? { awsCode } : {}),
  });
});

const stsRequest = (
  action: "AssumeRole" | "GetCallerIdentity",
  input: AwsIamInput,
  credentials: AwsCredentials,
  fields: Record<string, string> = {},
) =>
  executeSigned({
    stage: action === "AssumeRole" ? "assume_role" : "identity",
    url: `https://sts.${input.region}.amazonaws.com/`,
    service: "sts",
    region: input.region,
    credentials,
    body: new URLSearchParams({ Action: action, Version: "2011-06-15", ...fields }).toString(),
    contentType: "application/x-www-form-urlencoded; charset=utf-8",
  });

const assumeRole = Effect.fn("McpAwsIam.assumeRole")(function* (input: AwsIamInput) {
  const body = yield* stsRequest("AssumeRole", input, input.bootstrap, {
    RoleArn: input.roleArn,
    RoleSessionName: "executor-aws-mcp",
    DurationSeconds: "3600",
    ...(input.externalId ? { ExternalId: input.externalId } : {}),
  });
  const parsed = yield* parseXml(body, "assume_role");
  const decoded = yield* decodeStsCredentials(parsed).pipe(
    Effect.mapError(
      () =>
        new AwsIamAuthError({
          stage: "assume_role",
          message: "AWS STS returned an incomplete AssumeRole response",
        }),
    ),
  );
  const credentials = decoded.AssumeRoleResponse.AssumeRoleResult.Credentials;
  const expiration = Date.parse(credentials.Expiration);
  if (!Number.isFinite(expiration)) {
    return yield* new AwsIamAuthError({
      stage: "assume_role",
      message: "AWS STS returned an invalid role expiration",
    });
  }
  return {
    credentials: {
      accessKeyId: credentials.AccessKeyId,
      secretAccessKey: credentials.SecretAccessKey,
      sessionToken: credentials.SessionToken,
    } satisfies AwsCredentials,
    expiration,
  };
});

const getCallerIdentity = Effect.fn("McpAwsIam.getCallerIdentity")(function* (
  input: AwsIamInput,
  credentials: AwsCredentials,
) {
  const body = yield* stsRequest("GetCallerIdentity", input, credentials);
  const parsed = yield* parseXml(body, "identity");
  const decoded = yield* decodeStsIdentity(parsed).pipe(
    Effect.mapError(
      () =>
        new AwsIamAuthError({
          stage: "identity",
          message: "AWS STS returned an incomplete caller identity",
        }),
    ),
  );
  const identity = decoded.GetCallerIdentityResponse.GetCallerIdentityResult;
  if (identity.Account !== input.expectedAccountId) {
    return yield* new AwsIamAuthError({
      stage: "identity",
      message: `Assumed role resolved to AWS account ${identity.Account}, expected ${input.expectedAccountId}`,
    });
  }
  return { accountId: identity.Account, arn: identity.Arn };
});

const createMcpToken = Effect.fn("McpAwsIam.createToken")(function* (
  input: AwsIamInput,
  credentials: AwsCredentials,
) {
  const body = encodeJson({
    grant_type: "client_credentials",
    resource: "aws-mcp.amazonaws.com",
  });
  const response = yield* executeSigned({
    stage: "token",
    url: `https://${input.region}.oauth.signin.aws/v1/token?x-amz-client-auth-method=iam`,
    service: "signin",
    region: input.region,
    credentials,
    body,
    contentType: "application/json",
  });
  const decoded = yield* decodeTokenResponse(response).pipe(
    Effect.mapError(
      () =>
        new AwsIamAuthError({
          stage: "token",
          message: "AWS Sign-In returned an incomplete token response",
        }),
    ),
  );
  if (decoded.token_type.toLowerCase() !== "bearer" || decoded.expires_in <= 0) {
    return yield* new AwsIamAuthError({
      stage: "token",
      message: "AWS Sign-In returned an invalid bearer token",
    });
  }
  return {
    accessToken: decoded.access_token,
    expiresAt: Date.now() + decoded.expires_in * 1_000,
  };
});

const credentialFingerprint = (input: AwsIamInput): Effect.Effect<string, AwsIamAuthError> =>
  Effect.tryPromise({
    try: async () => {
      const material = encodeJson({
        ...input,
        bootstrap: input.bootstrap,
      });
      const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(material));
      return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join(
        "",
      );
    },
    catch: () =>
      new AwsIamAuthError({
        stage: "credentials",
        message: "Could not fingerprint the AWS credential configuration",
      }),
  });

export interface AwsIamTokenManager {
  readonly resolve: (
    connectionKey: string,
    endpoint: string,
    values: Record<string, string | null>,
  ) => Effect.Effect<AwsIamResolvedToken, AwsIamAuthError, HttpClient.HttpClient>;
  readonly clear: () => void;
}

export const createAwsIamTokenManager = (): AwsIamTokenManager => {
  const cache = new Map<string, AwsIamResolvedToken>();
  const inFlight = new Map<
    string,
    Effect.Effect<AwsIamResolvedToken, AwsIamAuthError, HttpClient.HttpClient>
  >();

  let generation = 0;
  const resolve: AwsIamTokenManager["resolve"] = (connectionKey, endpoint, values) =>
    Effect.gen(function* () {
      const region = managedAwsMcpRegion(endpoint);
      if (!region) {
        return yield* new AwsIamAuthError({
          stage: "credentials",
          message: "AWS IAM authentication can only be used with a managed AWS MCP endpoint",
        });
      }
      const input = yield* parseAwsIamInput(values, region);
      const fingerprint = yield* credentialFingerprint(input);
      const key = `${connectionKey}:${fingerprint}`;
      const cached = cache.get(key);
      if (cached && cached.expiresAt - REFRESH_SKEW_MS > Date.now()) return cached;

      const existing = inFlight.get(key);
      if (existing) return yield* existing;

      const mint = Effect.gen(function* () {
        const assumed = yield* assumeRole(input);
        const identity = yield* getCallerIdentity(input, assumed.credentials);
        const token = yield* createMcpToken(input, assumed.credentials);
        const resolved = {
          ...token,
          expiresAt: Math.min(token.expiresAt, assumed.expiration),
          ...identity,
          version: ++generation,
        } satisfies AwsIamResolvedToken;
        cache.set(key, resolved);
        return resolved;
      });
      const memoized = yield* Effect.cached(mint);
      const gated = memoized.pipe(Effect.ensuring(Effect.sync(() => inFlight.delete(key))));
      const winner = inFlight.get(key) ?? gated;
      if (winner === gated) inFlight.set(key, gated);
      return yield* winner;
    });

  return { resolve, clear: () => cache.clear() };
};
