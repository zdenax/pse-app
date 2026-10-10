import catalog from "../../Sources/NetSketchCore/Resources/devices.json";
import type { CatalogFile } from "../src/core/model";

test("the shared device catalog is readable", () => {
  const file = catalog as unknown as CatalogFile;
  expect(file.templates.length).toBeGreaterThan(10);
});
