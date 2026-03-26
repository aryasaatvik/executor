// Middleware placeholder for future auth middleware.
//
// Currently the RPC handlers resolve the active workspace directly via
// `requireRuntimeLocalWorkspace()` in each handler, matching the REST API
// pattern. When the client SDK ships (M4.2+), this file will hold the
// ExecutorAuthMiddleware implementation that validates client identity and
// resolves workspace/account context.
