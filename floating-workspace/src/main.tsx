import { createRoot } from 'react-dom/client';
import { App } from './App';

// StrictMode intentionally disabled — each `factory.create()` owns real I/O
// (pointer listeners, runtime/store, saga task, xstate actor). StrictMode's
// dev-only double-invoke of useMemo factories creates two engines per mount,
// the first disposed by cleanup, leaving the tree referencing a disposed
// engine. Production builds are unaffected.
createRoot(document.getElementById('root')!).render(<App />);
