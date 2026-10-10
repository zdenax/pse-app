import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./ui/App";
import { loadWiring } from "./ui/wiring";
import { WiringFailed } from "./ui/WiringFailed";

const root = createRoot(document.getElementById("root")!);

loadWiring().then(
  (wiring) => {
    root.render(
      <StrictMode>
        <App {...wiring} />
      </StrictMode>,
    );
  },
  (error: unknown) => {
    console.warn("NetSketch: wiring failed", error);
    root.render(
      <StrictMode>
        <WiringFailed error={error} />
      </StrictMode>,
    );
  },
);
