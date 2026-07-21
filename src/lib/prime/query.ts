/**
 * Prime v2 uses a single `q` query parameter with the form
 *   q='fieldName'.operation(value)
 * (operators: eq, neq, gt, gte, lt, lte, in, like) — NOT bracketed
 * `filter[field]=value` params. Confirmed against Prime's v2 API reference.
 *
 * This builds an exact-match (`eq`) filter, which is all the matching engine
 * needs (work order by reference/job number, contact by ABN/name). String
 * values are single-quoted per the documented example
 * (`'createdAt'.gte('2024-01-01 00:00:00')`); any single quote in the value is
 * escaped by doubling, the usual convention for quoted literals.
 */
export function buildEqQuery(field: string, value: string): string {
  const escaped = value.replace(/'/g, "''");
  return `'${field}'.eq('${escaped}')`;
}
