// SVG drawing of a DiagramScene in canvas coordinates (DiagramRenderer.draw). The live canvas and
// the PNG / SVG / PDF exporter share this component, so what is exported is exactly what is on
// screen (minus selection and hover).

import { Fragment, memo } from "react";
import type { PortRef } from "../../core/model";
import { canvasFontFamily } from "../text";
import type { Palette } from "../palette";
import type { DiagramScene } from "../scene";
import { AnnotationView, BundleLayer, CableDecorations, CableLayer } from "./cables";
import { NodeHeader, NodeSelection, PanelLabels, PanelView, PortHighlights } from "./nodes";
import { n } from "./svg";

/** Everything that varies between "live canvas", "dark canvas" and "export" for one drawing. */
export interface RenderOptions {
  palette: Palette;
  /** Current zoom; only used to skip details that would be illegible anyway. */
  zoom: number;
  /** Export: no selection, no hover, no interactive affordances. */
  isExport: boolean;
  selectedDevices: ReadonlySet<string>;
  selectedLinks: ReadonlySet<string>;
  selectedAnnotations: ReadonlySet<string>;
  /** First clicked port of the cabling flow. */
  pendingPort: PortRef | null;
  hoverPort: PortRef | null;
  /** The hovered port cannot take a cable (already used). */
  hoverPortRejected: boolean;
  /** Port that just refused a click. */
  rejectedPort: PortRef | null;
  hoverLinks: ReadonlySet<string>;
  /** Device whose hostname is being edited inline (the text is hidden under the editor). */
  editingDevice: string | null;
  editingAnnotation: string | null;
}

const emptySet: ReadonlySet<string> = new Set();

export function exportOptions(palette: Palette): RenderOptions {
  return {
    palette,
    zoom: 1,
    isExport: true,
    selectedDevices: emptySet,
    selectedLinks: emptySet,
    selectedAnnotations: emptySet,
    pendingPort: null,
    hoverPort: null,
    hoverPortRejected: false,
    rejectedPort: null,
    hoverLinks: emptySet,
    editingDevice: null,
    editingAnnotation: null,
  };
}

export function showsPortLabels(options: RenderOptions): boolean {
  return options.isExport || options.zoom >= 0.5;
}

export function showsCableLabels(options: RenderOptions): boolean {
  return options.isExport || options.zoom >= 0.4;
}

/** Shared text attributes of the whole drawing. */
export const diagramTextAttributes = { fontFamily: canvasFontFamily } as const;

export const DiagramLayers = memo(function DiagramLayers({
  scene,
  options: o,
}: {
  scene: DiagramScene;
  options: RenderOptions;
}) {
  const palette = o.palette;
  const portLabels = showsPortLabels(o);
  const physical = scene.mode === "physical";

  const portOn = (ref: PortRef | null, deviceID: string) => (ref && ref.deviceID === deviceID ? ref.portID : null);

  const body = (index: number) => {
    const node = scene.nodes[index];
    const id = node.deviceID;
    const selected = !o.isExport && o.selectedDevices.has(id);
    const panel = node.panel;
    return (
      <Fragment key={`b-${id}`}>
        {selected && <NodeSelection node={node} palette={palette} />}
        {panel && (
          // The panel is drawn in its own coordinates: moving a device changes only this transform.
          <g transform={`translate(${n(panel.frame.x)} ${n(panel.frame.y)})`}>
            <PanelView
              panel={panel.local}
              used={(scene.usedPortsByDevice.get(id) ?? []).join(" ")}
              palette={palette}
            />
            {!o.isExport && (
              <PortHighlights
                panel={panel.local}
                pending={portOn(o.pendingPort, id)}
                rejected={portOn(o.rejectedPort, id)}
                hover={portOn(o.hoverPort, id)}
                hoverRejected={o.hoverPortRejected && portOn(o.hoverPort, id) !== null}
                palette={palette}
              />
            )}
            {portLabels && <PanelLabels panel={panel.local} palette={palette} />}
          </g>
        )}
      </Fragment>
    );
  };
  const header = (index: number) => {
    const node = scene.nodes[index];
    return (
      <NodeHeader
        key={`h-${node.deviceID}`}
        node={node}
        palette={palette}
        editing={!o.isExport && o.editingDevice === node.deviceID}
      />
    );
  };
  const indices = scene.nodes.map((_, index) => index);

  const cables = (
    <CableLayer
      links={scene.links}
      mode={scene.mode}
      palette={palette}
      selectedLinks={o.selectedLinks}
      hoverLinks={o.hoverLinks}
      isExport={o.isExport}
    />
  );
  const bundles = (
    <BundleLayer bundles={scene.bundles} palette={palette} selectedLinks={o.selectedLinks} isExport={o.isExport} />
  );

  return (
    <g>
      {physical ? (
        <>
          {/* Panels at the bottom, cables plugged into them, then names, then cable labels. */}
          <g>{indices.map(body)}</g>
          {cables}
          <g>{indices.map(header)}</g>
          <CableDecorations
            links={scene.links}
            palette={palette}
            isExport={o.isExport}
            showLabels={showsCableLabels(o)}
          />
          {bundles}
        </>
      ) : (
        <>
          {cables}
          <g>
            {indices.map((index) => (
              <Fragment key={scene.nodes[index].deviceID}>
                {body(index)}
                {header(index)}
              </Fragment>
            ))}
          </g>
          {bundles}
        </>
      )}
      <g>
        {scene.annotations.map((annotation) => (
          <AnnotationView
            key={annotation.id}
            annotation={annotation}
            palette={palette}
            selected={!o.isExport && o.selectedAnnotations.has(annotation.id)}
            editing={!o.isExport && o.editingAnnotation === annotation.id}
          />
        ))}
      </g>
    </g>
  );
});
