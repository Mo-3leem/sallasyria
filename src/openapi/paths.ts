// Path-template normalization for the served OpenAPI document.
//
// Root cause it fixes (found via production Swagger screenshots): the
// generator emits Hono-style `:param` segments for routes registered
// directly on a router (e.g. `/stores/:storeId`), while mounted prefixes
// come out as OpenAPI-style `{storeId}`. `:param` is NOT valid OpenAPI, and
// Swagger UI only substitutes `{param}` tokens — so it sent the literal text
// `/stores/:storeId` on the wire, and every such call 404'd despite a correct
// value sitting in the parameter box.
//
// The fix is docs-only and total: rewrite every `:name` segment in path keys
// to `{name}` before serving. Runtime routing, validation, and handlers are
// untouched (Hono keeps matching `:param` routes as before).
export function normalizeDocPaths<T extends { paths?: Record<string, unknown> }>(doc: T): T {
  if (!doc.paths) return doc;
  const paths: Record<string, unknown> = {};
  for (const [path, ops] of Object.entries(doc.paths)) {
    paths[path.replace(/:([A-Za-z0-9_]+)/g, "{$1}")] = ops;
  }
  return { ...doc, paths };
}
