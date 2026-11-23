// Cordis 4.2 exposes Context.root as this shared symbol. Resolve it without
// importing a separate copy of Cordis; older hosts still expose `ctx.root`.
const cordisRoot = Symbol.for('cordis.root')

export function rootContextOf(ctx) {
  return ctx?.[cordisRoot] ?? ctx?.root ?? ctx
}
