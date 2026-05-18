import { createRoot } from 'react-dom/client';
import { App } from './App';

// NOTE: StrictMode disabled — it double-invokes useMemo factories in dev,
// which creates two engine instances; the first gets disposed by the cleanup
// effect, leaving the rendered tree referencing a disposed engine. Each
// engine factory.create() owns I/O (runtime, store, saga task), so it's
// genuinely not StrictMode-safe at this level. Production builds are fine.
createRoot(document.getElementById('root')!).render(<App />);
