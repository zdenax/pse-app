// Shown by main.tsx when ui/wiring.ts cannot provide the store and the consoles yet.

import { errorMessage } from "./app-model";
import "./styles.css";

export function WiringFailed({ error }: { error: unknown }) {
  return (
    <div className="wiring-failed" role="alert">
      <div className="wiring-failed-card">
        <h1>NetSketch (web) – rozpracováno</h1>
        <p>
          Uživatelské rozhraní je připravené, ale ještě není propojené s jádrem aplikace a s konzolemi
          zařízení. Jakmile budou hotové, aplikace se tady normálně otevře.
        </p>
        <p className="secondary small">{errorMessage(error)}</p>
      </div>
    </div>
  );
}
