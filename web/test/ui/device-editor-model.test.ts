import { describe, expect, it } from "vitest";
import { Catalog } from "../../src/core/catalog";
import { templatePortCount } from "../../src/core/template";
import {
  draftProblems,
  draftTemplate,
  groupPreview,
  makeDraft,
  newGroupDraft,
  nextRangeGroup,
  totalPorts,
} from "../../src/ui/device-editor-model";

describe("device editor model", () => {
  it("new draft has 24 ports + console and needs a model name", () => {
    const draft = makeDraft({ kind: "new" });
    expect(totalPorts(draft)).toBe(25);
    expect(draftProblems(draft)).toEqual(["Vyplňte název modelu."]);
    draft.model = "Lab Switch 24";
    expect(draftProblems(draft)).toEqual([]);
  });

  it("reports bad ranges, empty names and duplicates", () => {
    const draft = makeDraft({ kind: "new" });
    draft.model = "X";
    draft.groups[0].from = 10;
    draft.groups[0].to = 2;
    expect(draftProblems(draft)[0]).toMatch(/Skupina 1/);
    draft.groups[0] = newGroupDraft({ prefix: "Gi0/", from: 1, to: 2 });
    draft.groups[1] = newGroupDraft({ prefix: "Gi0/", from: 2, to: 3 });
    expect(draftProblems(draft)).toEqual(["Názvy portů se opakují: Gi0/2."]);
    draft.groups = [newGroupDraft({ from: 0, to: 999 })];
    expect(draftProblems(draft)[0]).toMatch(/příliš velký/);
    draft.groups = [newGroupDraft({ from: Number.NaN, to: 3 })];
    expect(draftProblems(draft)[0]).toMatch(/celá čísla/);
  });

  it("previews a group", () => {
    expect(groupPreview(newGroupDraft({ prefix: "Fa0/", from: 1, to: 24 }))).toBe("Fa0/1 … Fa0/24, 24 portů");
    expect(nextRangeGroup(makeDraft({ kind: "new" })).from).toBe(25);
  });

  it("saves into the catalog, edits and keeps the layout while ports are unchanged", () => {
    const catalog = new Catalog({ builtIn: [], custom: [] });
    const draft = makeDraft({ kind: "new" });
    draft.model = "Lab Switch 24";
    draft.vendor = "Acme";
    const added = catalog.addCustom(draftTemplate(draft, catalog.uniqueID(draft.vendor, draft.model)));
    expect(added.id).toBe("acme-lab-switch-24");
    expect(added.isCustom).toBe(true);
    expect(templatePortCount(added)).toBe(25);

    const edit = makeDraft({ kind: "edit", template: added });
    expect(edit.original).toBe(added);
    edit.note = "pozn.";
    const same = draftTemplate(edit, "ignored");
    expect(same.id).toBe(added.id);
    expect(same.layout).toEqual(added.layout);
    edit.groups[0].to = 12;
    expect(draftTemplate(edit, "ignored").layout).not.toEqual(added.layout);
    expect(catalog.updateCustom(draftTemplate(edit, "x")).note).toBe("pozn.");
    expect(templatePortCount(catalog.template(added.id)!)).toBe(13);
  });

  it("duplicate gets a new name and is unverified", () => {
    const catalog = new Catalog();
    const source = catalog.builtIn[0];
    const draft = makeDraft({ kind: "duplicate", template: source });
    expect(draft.model).toBe(source.model + " (vlastní)");
    expect(draft.original).toBeUndefined();
    const t = draftTemplate(draft, catalog.uniqueID(draft.vendor, draft.model));
    expect(templatePortCount(t)).toBe(templatePortCount(source));
  });
});
