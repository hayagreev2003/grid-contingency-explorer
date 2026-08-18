// Next only ships declarations for `*.module.css`; plain side-effect CSS imports
// trip TS2882 under `noUncheckedSideEffectImports` (VS Code enables it by default).
declare module '*.css'
