// Ambient declaration for global CSS side-effect imports (e.g. `import './globals.css'`).
// Next.js processes these via its build pipeline, but standalone `tsc --noEmit`
// needs an explicit module declaration to type-check the import.
declare module '*.css';
