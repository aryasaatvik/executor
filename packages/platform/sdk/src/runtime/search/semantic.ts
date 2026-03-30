export type SearchDocumentLike = {
  path: string;
  namespace: string;
  searchText: string;
  title: string | null;
  description: string | null;
  protocol: string | null;
  method: string | null;
  pathTemplate: string | null;
  operationId: string | null;
  group: string | null;
  leaf: string | null;
  tags: readonly string[];
};

export type SearchEmbedder = {
  key: string;
  dimensions: number;
  embedDocument: (document: SearchDocumentLike) => Float32Array;
  embedQuery: (query: string) => Float32Array;
};

export type SearchVectorRecord = {
  id: string;
  embedding: Float32Array;
};

export type SearchVectorMatch = {
  id: string;
  distance: number;
};

export type SearchVectorBackend = {
  key: string;
  init: () => Promise<void>;
  isAvailable: () => boolean;
  detail: () => string | null;
  isRebuildRequired: () => boolean;
  markRebuilt: () => void;
  upsert: (records: readonly SearchVectorRecord[]) => void;
  removeByIds: (ids: readonly string[]) => void;
  search: (input: {
    embedding: Float32Array;
    limit: number;
  }) => readonly SearchVectorMatch[];
  rebuild: (records: readonly SearchVectorRecord[]) => void;
};

export type SearchRerankCandidate = {
  id: string;
  score: number;
  lexicalScore: number;
  ftsRank?: number;
  ftsScore?: number;
  ftsRawRank?: number;
  vectorRank?: number;
  vectorScore?: number;
  vectorDistance?: number;
};

export type SearchReranker = {
  key: string;
  rerank: (
    input: {
      query: string;
      candidates: readonly SearchRerankCandidate[];
    },
  ) => readonly SearchRerankCandidate[];
};
