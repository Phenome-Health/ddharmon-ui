import { createRoot } from "react-dom/client";
import App from "./App";
import "./index.css";

// Every build names itself on <html> (`lib/build-stamp.ts`), so the Lavish review build and a deploy can be matched.
if (__UI_TREE__) document.documentElement.dataset.uiTree = __UI_TREE__;

createRoot(document.getElementById("root")!).render(<App />);
