// Modal dialogs of the main window: the error/info alert and the (placeholder) custom-device editor.

import { Modal } from "./components";
import { useApp, useAppVersion } from "./store-context";

/** Shows AppModel.alert ("Akci nelze provést", "Soubor se nepodařilo otevřít"...). */
export function AlertHost() {
  useAppVersion();
  const app = useApp();
  const alert = app.alert;
  if (!alert) return null;
  return (
    <Modal key={alert.id} role="alertdialog" title={alert.title} onClose={() => app.dismissAlert()}>
      <p className="modal-message">{alert.message}</p>
    </Modal>
  );
}

/**
 * Placeholder of the custom-device editor (DeviceEditorView.swift in the Mac app).
 * TODO: port the editor (port groups, layout preview) once the catalog supports custom devices.
 */
export function DeviceEditorHost() {
  useAppVersion();
  const app = useApp();
  if (!app.deviceEditorOpen) return null;
  const close = () => (app.deviceEditorOpen = false);
  return (
    <Modal
      title="Nové zařízení"
      onClose={close}
      actions={
        <button type="button" className="push-button default" data-autofocus onClick={close}>
          Zavřít
        </button>
      }
    >
      <p className="modal-message">
        Editor vlastních zařízení (výrobce, model, kategorie, skupiny portů a rozložení čelního panelu) se do
        webové verze teprve připravuje.
      </p>
      <p className="modal-message secondary">
        Do té doby lze použít zařízení z katalogu, nebo vlastní zařízení vytvořit v aplikaci pro macOS.
      </p>
    </Modal>
  );
}
