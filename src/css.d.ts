// Ambient declaration for global (side-effect) CSS imports such as
// `import "./globals.css"`. Next.js ships types for `*.module.css` only,
// so without this `noUncheckedSideEffectImports` rejects global CSS.
declare module "*.css";
