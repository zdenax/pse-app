// Modal dialogs of the main window: the error/info alert and the custom-device editor.

import { Modal } from "./components";
import { DeviceEditorDialog } from "./DeviceEditor";
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

/** The editor of custom devices (DeviceEditorView.swift in the Mac app). */
export function DeviceEditorHost() {
  useAppVersion();
  const app = useApp();
  const request = app.deviceEditor;
  if (!request) return null;
  return <DeviceEditorDialog request={request} onClose={() => app.closeDeviceEditor()} />;
}
