// The right-hand column. What it shows follows store.selection.
// Port of Sources/NetSketch/Views/InspectorView.swift.

import { memo, useEffect, useState } from "react";
import type { Annotation, CableType, Device, Link, LinkBundle, LinkEnd, Port, PortRef } from "../core/model";
import type { ProjectStoreAPI } from "../core/store-api";
import { errorMessage, type AppModel } from "./app-model";
import {
  CommitTextField,
  Hint,
  InspectorRow,
  InspectorSection,
  StatusPicker,
  VerifyBadge,
  VerifyNote,
} from "./components";
import {
  cableDescription,
  cablesText,
  cableTypes,
  categoryName,
  connectorName,
  devicesText,
  displayName,
  linkStatusName,
  notesText,
  shortPortName,
} from "./czech";
import { DeviceIcon } from "./DeviceIcon";
import { commitLinkQuality, qualityText } from "./link-quality";
import { Icon, type IconName } from "./icons";
import { consoleShortcutLabel, altName } from "./platform";
import {
  bundleOfLink,
  connectionsOfDevice,
  deviceNeedsVerification,
  findAnnotation,
  findBundle,
  findDevice,
  findLink,
  interfaceName,
  resolvePort,
  selectedIDs,
  type PortConnection,
} from "./project-helpers";
import { useApp, useStore, useStoreVersion } from "./store-context";

/** "Jak začít" hints of the project inspector (InspectorView.swift `hints`). */
export function projectHints(consoleShortcut = consoleShortcutLabel()): string[] {
  return [
    "Zařízení přetáhněte z palety na plátno, nebo na něj v paletě dvakrát klikněte.",
    "Kabel vznikne kliknutím na jeden port a potom na druhý. Typ kabelu se volí na liště.",
    "Výběrem zařízení nebo kabelu se tady zobrazí jeho vlastnosti.",
    `Vybrané zařízení nastavíte v konzoli (${consoleShortcut}): IP adresy, VLAN, trasy. Ping a traceroute ` +
      "projdou podle kabelů, VLAN a tras.",
    "Hotová cvičení jsou ve složce examples (Soubor > Otevřít).",
    "Nesimuluje se STP, LACP, OSPF ani DHCP.",
  ];
}

export const Inspector = memo(function Inspector() {
  useStoreVersion();
  const store = useStore();
  const selection = store.selection;
  const project = store.project;

  let content;
  if (selection.length === 1) {
    const item = selection[0];
    if (item.kind === "device") {
      const device = findDevice(project, item.id);
      content = device ? <DeviceInspector key={item.id} device={device} /> : null;
    } else if (item.kind === "link") {
      const link = findLink(project, item.id);
      content = link ? <LinkInspector key={item.id} link={link} /> : null;
    } else {
      const annotation = findAnnotation(project, item.id);
      content = annotation ? <AnnotationInspector key={item.id} annotation={annotation} /> : null;
    }
  } else if (selection.length === 0) {
    content = <ProjectInspector />;
  } else {
    content = <MultiSelectionInspector />;
  }

  return (
    <aside className="inspector" aria-label="Inspektor">
      {content}
    </aside>
  );
});

function InspectorHeader({
  icon,
  device,
  title,
  subtitle,
}: {
  icon?: IconName;
  device?: Device;
  title: string;
  subtitle?: string;
}) {
  return (
    <div className="inspector-header">
      {device ? (
        <DeviceIcon category={device.category} size={36} />
      ) : (
        <span className="inspector-header-icon">{icon && <Icon name={icon} size={26} />}</span>
      )}
      <div className="inspector-header-text">
        <h2 className="inspector-header-title">{title}</h2>
        {subtitle && <div className="inspector-header-subtitle">{subtitle}</div>}
      </div>
    </div>
  );
}

// MARK: - Device

function DeviceInspector({ device }: { device: Device }) {
  const store = useStore();
  const app = useApp();
  const [connectedOnly, setConnectedOnly] = useState(false);
  const connections = connectionsOfDevice(store.project, device);
  const connectedCount = connections.filter((connection) => connection.link !== null).length;
  const visible = connectedOnly ? connections.filter((connection) => connection.link !== null) : connections;
  const reason = app.consoleUnavailableReason(device);
  const model = displayName(device.vendor, device.model);

  return (
    <div className="inspector-scroll">
      <InspectorHeader device={device} title={device.hostname} subtitle={model === "" ? categoryName(device.category) : model} />

      <InspectorSection title="Zařízení">
        <InspectorRow label="Hostname">
          <CommitTextField
            value={device.hostname}
            placeholder="Hostname"
            onCommit={(text) => app.perform("Zařízení nelze přejmenovat", () => store.renameDevice(device.id, text))}
          />
        </InspectorRow>
        <InspectorRow label="Výrobce">
          <span className="selectable">{device.vendor === "" ? "neuveden" : device.vendor}</span>
        </InspectorRow>
        <InspectorRow label="Model">
          <span className="selectable">{device.model === "" ? "neuveden" : device.model}</span>
        </InspectorRow>
        <InspectorRow label="Kategorie">
          <span>{categoryName(device.category)}</span>
        </InspectorRow>
        {deviceNeedsVerification(device) && (
          <VerifyNote>Počty a názvy portů nejsou ověřené. Zkontrolujte je podle skutečného hardwaru.</VerifyNote>
        )}
      </InspectorSection>

      <span className="block-button-wrap" title={reason ?? `Otevře konfigurační konzoli zařízení (${consoleShortcutLabel()})`}>
        <button
          type="button"
          className="push-button large wide"
          disabled={reason !== null}
          onClick={() => app.openConsole(device.id)}
        >
          <Icon name="terminal" size={16} />
          Otevřít konzoli
        </button>
      </span>

      <InspectorSection title="Poznámka">
        <CommitTextField
          value={device.note}
          placeholder="Poznámka k zařízení"
          multiline
          onCommit={(text) => app.perform(() => store.setDeviceNote(device.id, text))}
        />
      </InspectorSection>

      {device.vlans.length > 0 && (
        <InspectorSection title="VLAN (z konzole)">
          <table className="vlan-table">
            <tbody>
              {device.vlans.map((vlan) => (
                <tr key={vlan.id}>
                  <td className="vlan-id mono">{vlan.id}</td>
                  <td className={vlan.name === "" ? "secondary" : undefined}>{vlan.name === "" ? "bez názvu" : vlan.name}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <Hint>Tabulka se upravuje příkazy v konzoli. Ping v konzoli respektuje VLAN na portech a trunky.</Hint>
        </InspectorSection>
      )}

      {(device.addresses.length > 0 || device.defaultGateway !== "" || device.staticRoutes.length > 0) && (
        <InspectorSection title="IP (z konzole)">
          <table className="ip-table">
            <tbody>
              {device.addresses.map((entry) => (
                <tr key={entry.interface + entry.address}>
                  <th scope="row">{interfaceName(device, entry.interface)}</th>
                  <td className="mono selectable">{entry.address}</td>
                </tr>
              ))}
              {device.defaultGateway !== "" && (
                <tr>
                  <th scope="row">Výchozí brána</th>
                  <td className="mono selectable">{device.defaultGateway}</td>
                </tr>
              )}
              {device.staticRoutes.map((route, index) => (
                <tr key={`${route.destination}-${route.nextHop}-${index}`}>
                  <th scope="row">Trasa</th>
                  <td className="mono selectable">{`${route.destination} přes ${route.nextHop}`}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <Hint>
            Nastavuje se v konzoli (ip address, ip route, netsh). Ping a traceroute v konzoli podle toho hledají cestu.
          </Hint>
        </InspectorSection>
      )}

      <section className="ports-section" aria-label="Porty">
        <div className="ports-header">
          <span className="section-title">PORTY</span>
          <span className="ports-count">{`zapojeno ${connectedCount} z ${connections.length}`}</span>
          <label className="checkbox">
            <input type="checkbox" checked={connectedOnly} onChange={(event) => setConnectedOnly(event.target.checked)} />
            Jen zapojené
          </label>
        </div>
        {visible.length === 0 && (
          <p className="hint ports-empty">{connectedOnly ? "Žádný port není zapojený." : "Zařízení nemá žádné porty."}</p>
        )}
        <ul className="port-list">
          {visible.map((connection) => (
            <PortRow key={connection.port.id} deviceID={device.id} connection={connection} store={store} app={app} />
          ))}
        </ul>
      </section>
    </div>
  );
}

/** One port: name, connector and speed, what is plugged in, description, VLAN text, shutdown flag. */
function PortRow({
  deviceID,
  connection,
  store,
  app,
}: {
  deviceID: string;
  connection: PortConnection;
  store: ProjectStoreAPI;
  app: AppModel;
}) {
  const port: Port = connection.port;
  const ref: PortRef = { deviceID, portID: port.id };
  const detail = [connectorName(port.connector), port.speed].filter((part) => part !== "").join(" · ");

  let peer;
  if (connection.peer && connection.link) {
    const link = connection.link;
    const { device: peerDevice, port: peerPort } = connection.peer;
    peer = (
      <button
        type="button"
        className="peer-link"
        title={`Zapojeno do ${peerDevice.hostname}, port ${peerPort.name}. Kliknutím vyberete kabel.`}
        onClick={() => (store.selection = [{ kind: "link", id: link.id }])}
      >
        {`→ ${peerDevice.hostname} ${shortPortName(peerPort.name)}`}
      </button>
    );
  } else if (connection.link) {
    peer = <span className="secondary small">zapojeno</span>;
  } else {
    peer = <span className="secondary small">volný</span>;
  }

  return (
    <li className="port-row">
      <div className="port-row-line">
        <span className="port-name mono" title={port.name}>
          {port.name}
        </span>
        {!port.verified && <VerifyBadge size={13} />}
        <span className="spacer" />
        <span className="secondary small">{detail}</span>
      </div>
      <div className="port-row-line">
        {peer}
        <span className="spacer" />
        <button
          type="button"
          className={port.adminDown ? "toggle-chip on" : "toggle-chip"}
          aria-pressed={port.adminDown}
          title={
            port.adminDown
              ? "Port je administrativně vypnutý (shutdown). Kliknutím ho zapnete."
              : "Označit port jako administrativně vypnutý (shutdown). Jen zápis, nic se nesimuluje."
          }
          onClick={() => app.perform(() => store.setPortAdminDown(ref, !port.adminDown))}
        >
          shutdown
        </button>
      </div>
      <div className="port-row-line fields">
        <CommitTextField
          value={port.description}
          placeholder="Popis"
          label={`Popis portu ${port.name}`}
          className="small"
          onCommit={(text) => app.perform(() => store.setPortDescription(ref, text))}
        />
        <CommitTextField
          value={port.vlan}
          placeholder="VLAN"
          label={`VLAN portu ${port.name}`}
          className="small vlan-field"
          title="Volný text, např. „10“ nebo „trunk 10,20“. Bez logiky."
          onCommit={(text) => app.perform(() => store.setPortVLAN(ref, text))}
        />
      </div>
    </li>
  );
}

// MARK: - Link

function LinkInspector({ link }: { link: Link }) {
  const store = useStore();
  const app = useApp();
  const bundle = bundleOfLink(store.project, link.id);
  /** The commit handler of a delay / loss field: false (typed text refused) restores the field. */
  const commitQuality = (field: "delay" | "loss") => (text: string) => {
    let stored = false;
    app.perform(field === "delay" ? "Zpoždění nelze nastavit" : "Ztrátovost nelze nastavit", () => {
      stored = commitLinkQuality(store, link, field, text);
    });
    return stored;
  };

  return (
    <div className="inspector-scroll">
      <InspectorHeader icon="cable" title="Kabel" subtitle={cableDescription(link.cableType)} />

      <InspectorSection title="Konce kabelu">
        <LinkEndRow link={link} end="a" />
        <LinkEndRow link={link} end="b" />
        <Hint>Stav je jen ruční značka u konce kabelu, nic se nepočítá.</Hint>
      </InspectorSection>

      <InspectorSection title="Typ kabelu">
        <select
          className="select-field"
          aria-label="Typ kabelu"
          value={link.cableType}
          onChange={(event) => app.perform(() => store.setCableType(link.id, event.target.value as CableType))}
        >
          {cableTypes.map((type) => (
            <option key={type} value={type}>
              {cableDescription(type)}
            </option>
          ))}
        </select>
      </InspectorSection>

      <InspectorSection title="Kvalita spoje">
        <InspectorRow label="Zpoždění (ms)">
          <CommitTextField
            value={qualityText(link.delay)}
            placeholder="0"
            label="Zpoždění (ms)"
            inputMode="decimal"
            mono
            onCommit={commitQuality("delay")}
          />
        </InspectorRow>
        <InspectorRow label="Ztrátovost (%)">
          <CommitTextField
            value={qualityText(link.loss)}
            placeholder="0"
            label="Ztrátovost (%)"
            inputMode="decimal"
            mono
            onCommit={commitQuality("loss")}
          />
        </InspectorRow>
        <Hint>
          Zpoždění je jednosměrné: ping kabelem projde dvakrát. Ztrátovost zahazuje pakety. Bez obou hodnot
          vypisují konzole stále 0 ms.
        </Hint>
      </InspectorSection>

      <InspectorSection title="Poznámka">
        <CommitTextField
          value={link.note}
          placeholder="Poznámka ke kabelu"
          multiline
          onCommit={(text) => app.perform(() => store.setLinkNote(link.id, text))}
        />
      </InspectorSection>

      {bundle ? (
        <BundleSection bundle={bundle} />
      ) : (
        <InspectorSection title="Svazek (LAG)">
          <Hint>Kabel není ve svazku. Vyberte dva nebo více kabelů mezi stejnými zařízeními a seskupte je.</Hint>
        </InspectorSection>
      )}

      <button
        type="button"
        className="push-button destructive"
        onClick={() => app.perform("Kabel nelze odpojit", () => store.removeLink(link.id))}
      >
        <Icon name="trash" size={15} />
        Odpojit kabel
      </button>
    </div>
  );
}

function LinkEndRow({ link, end }: { link: Link; end: LinkEnd }) {
  const store = useStore();
  const app = useApp();
  const ref = end === "a" ? link.a : link.b;
  const status = end === "a" ? link.statusA : link.statusB;
  const resolved = resolvePort(store.project, ref);
  const letter = end === "a" ? "A" : "B";

  return (
    <div className="link-end">
      <div className="link-end-line">
        <span className="link-end-letter">{letter}</span>
        {resolved ? (
          <>
            <button
              type="button"
              className="plain-link strong"
              title={`Vybrat zařízení ${resolved.device.hostname}`}
              onClick={() => (store.selection = [{ kind: "device", id: resolved.device.id }])}
            >
              {resolved.device.hostname}
            </button>
            <span className="mono secondary ellipsis" title={resolved.port.name}>
              {resolved.port.name}
            </span>
          </>
        ) : (
          <span className="secondary">neznámý port</span>
        )}
      </div>
      <div className="link-end-status">
        <span className="secondary small">Stav</span>
        <StatusPicker
          status={status}
          label={`Stav konce ${letter}`}
          onChange={(next) => app.perform(() => store.setStatus(link.id, end, next))}
        />
        <button
          type="button"
          className="plain-link small secondary"
          title="Kliknutím přepnete na další stav"
          onClick={() => app.perform(() => void store.cycleStatus(link.id, end))}
        >
          {linkStatusName(status)}
        </button>
      </div>
    </div>
  );
}

/** Label and membership of a bundle (LAG). Shown for a member link or for the whole bundle selected. */
function BundleSection({ bundle }: { bundle: LinkBundle }) {
  const store = useStore();
  const app = useApp();
  return (
    <InspectorSection title="Svazek (LAG)">
      <InspectorRow label="Popisek">
        <CommitTextField
          value={bundle.label}
          placeholder="Po1 / bond1"
          label="Popisek svazku"
          onCommit={(text) => app.perform("Svazek nelze přejmenovat", () => store.renameBundle(bundle.id, text))}
        />
      </InspectorRow>
      <Hint>{`Ve svazku: ${cablesText(bundle.linkIDs.length)}. Svazek je jen kresba; EtherChannel se nastavuje v konzoli Cisco (channel-group).`}</Hint>
      <div className="button-row">
        <button
          type="button"
          className="push-button small"
          onClick={() => (store.selection = bundle.linkIDs.map((id) => ({ kind: "link" as const, id })))}
        >
          Vybrat celý svazek
        </button>
        <button
          type="button"
          className="push-button small"
          onClick={() => app.perform("Svazek nelze zrušit", () => store.unbundle(bundle.id))}
        >
          Zrušit svazek
        </button>
      </div>
    </InspectorSection>
  );
}

// MARK: - Annotation

function AnnotationInspector({ annotation }: { annotation: Annotation }) {
  const store = useStore();
  const app = useApp();
  return (
    <div className="inspector-scroll">
      <InspectorHeader icon="note" title="Textová poznámka" />
      <InspectorSection title="Text">
        <CommitTextField
          value={annotation.text}
          placeholder="Text poznámky"
          multiline
          minRows={3}
          maxRows={12}
          onCommit={(text) => app.perform(() => store.setAnnotationText(annotation.id, text))}
        />
        <Hint>{`Nový řádek vložíte klávesami ${altName}+${altName === "Option" ? "Return" : "Enter"}.`}</Hint>
      </InspectorSection>
      <button
        type="button"
        className="push-button destructive"
        onClick={() => app.perform("Poznámku nelze smazat", () => store.removeAnnotation(annotation.id))}
      >
        <Icon name="trash" size={15} />
        Smazat poznámku
      </button>
    </div>
  );
}

// MARK: - Several objects

function MultiSelectionInspector() {
  const store = useStore();
  const app = useApp();
  const [bundleLabel, setBundleLabel] = useState("");
  const [bundleError, setBundleError] = useState<string | null>(null);
  const selection = store.selection;
  const project = store.project;

  const linkIDs = selectedIDs(selection, "link");
  const deviceCount = selectedIDs(selection, "device").length;
  const annotationCount = selectedIDs(selection, "annotation").length;
  const bundleIDs = new Set<string>();
  let unbundledCount = 0;
  for (const id of linkIDs) {
    const bundle = bundleOfLink(project, id);
    if (bundle) bundleIDs.add(bundle.id);
    else unbundledCount += 1;
  }
  const selectionKey = selection.map((item) => item.kind + item.id).join(",");

  useEffect(() => {
    setBundleError(null);
  }, [selectionKey]);

  const summary = [
    deviceCount > 0 ? devicesText(deviceCount) : null,
    linkIDs.length > 0 ? cablesText(linkIDs.length) : null,
    annotationCount > 0 ? notesText(annotationCount) : null,
  ]
    .filter(Boolean)
    .join(", ");

  const createBundle = () => {
    try {
      store.createBundle(linkIDs, bundleLabel);
      setBundleLabel("");
      setBundleError(null);
    } catch (error) {
      setBundleError(errorMessage(error));
    }
  };

  const singleBundle = bundleIDs.size === 1 && unbundledCount === 0 ? findBundle(project, [...bundleIDs][0]) : undefined;

  return (
    <div className="inspector-scroll">
      <InspectorHeader icon="multi" title={`Vybráno objektů: ${selection.length}`} subtitle={summary} />

      {singleBundle ? (
        <BundleSection bundle={singleBundle} />
      ) : linkIDs.length >= 2 ? (
        <InspectorSection title="Svazek (LAG)">
          <InspectorRow label="Popisek">
            <input
              type="text"
              className="text-field"
              value={bundleLabel}
              placeholder="automaticky (Po1 / bond1)"
              aria-label="Popisek svazku"
              onChange={(event) => setBundleLabel(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  createBundle();
                }
              }}
            />
          </InspectorRow>
          <button type="button" className="push-button" onClick={createBundle}>
            <Icon name="linkAdd" size={15} />
            Seskupit do svazku (LAG)
          </button>
          {bundleError && (
            <div className="inline-error" role="alert">
              {bundleError}
            </div>
          )}
          <Hint>Svazek je jen vizuální seskupení kabelů mezi stejnou dvojicí zařízení.</Hint>
        </InspectorSection>
      ) : null}

      <button type="button" className="push-button destructive" onClick={() => app.deleteSelection()}>
        <Icon name="trash" size={15} />
        Smazat výběr
      </button>
    </div>
  );
}

// MARK: - Nothing selected

function ProjectInspector() {
  const store = useStore();
  const app = useApp();
  const project = store.project;
  const unverified = project.devices.filter(deviceNeedsVerification).length;

  return (
    <div className="inspector-scroll">
      <InspectorHeader
        icon="project"
        title={app.documentName}
        subtitle={store.fileName ?? "Projekt ještě není uložen"}
      />

      <InspectorSection title="Projekt">
        <InspectorRow label="Název">
          <CommitTextField
            value={project.name}
            placeholder="Název projektu"
            onCommit={(text) => app.perform(() => store.renameProject(text))}
          />
        </InspectorRow>
        <InspectorRow label="Zařízení">{project.devices.length}</InspectorRow>
        <InspectorRow label="Kabely">{project.links.length}</InspectorRow>
        <InspectorRow label="Svazky">{project.bundles.length}</InspectorRow>
        <InspectorRow label="Poznámky">{project.annotations.length}</InspectorRow>
      </InspectorSection>

      {unverified > 0 && (
        <VerifyNote>
          {`Neověřená zařízení: ${unverified}. Počty a názvy portů z katalogu zkontrolujte podle skutečného hardwaru.`}
        </VerifyNote>
      )}

      <InspectorSection title="Jak začít">
        <ul className="hints">
          {projectHints().map((hint) => (
            <li key={hint}>{hint}</li>
          ))}
        </ul>
      </InspectorSection>
    </div>
  );
}
