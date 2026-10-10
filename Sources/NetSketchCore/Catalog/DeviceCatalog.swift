import Foundation
import Observation

/// Why a catalog operation was refused.
public enum CatalogError: Error, Equatable, Sendable {
    /// A template with this id already exists (built-in or custom).
    case duplicateID(String)
    /// No custom template has this id.
    case unknownTemplate(String)
    /// The id belongs to a built-in template, which cannot be changed or removed.
    case notCustom(String)
    /// The template is unusable; the text says why (diagnostic, English).
    case invalidTemplate(String)
}

/// The templates of one category, for the device palette.
public struct TemplateGroup: Identifiable, Equatable, Sendable {
    public let category: DeviceCategory
    public let templates: [DeviceTemplate]
    public var id: DeviceCategory { category }

    public init(category: DeviceCategory, templates: [DeviceTemplate]) {
        self.category = category
        self.templates = templates
    }
}

/// The device catalog: built-in templates plus the user's custom templates.
///
/// Files (all JSON, `{"formatVersion": 1, "templates": [...]}`; a bare array is accepted too):
/// - built-in: `devices.json` bundled with NetSketchCore;
/// - override: `<support>/devices.json` - if present and valid it REPLACES the bundled file,
///   so the catalog can be edited without recompiling;
/// - custom: `<support>/custom-devices.json` - written by `addCustom` / `updateCustom` / `removeCustom`.
///
/// `<support>` defaults to `~/Library/Application Support/NetSketch` and is injectable.
/// Pass `supportDirectory: nil` for a bundle-only catalog that never touches the disk.
@Observable
public final class DeviceCatalog {
    /// Where the built-in templates came from.
    public enum BuiltInSource: Equatable, Sendable {
        /// The devices.json bundled with the module.
        case bundle
        /// The override file in the support directory.
        case overrideFile(URL)
        /// Handed in directly (initializer or `loadBuiltIn`).
        case provided
    }

    public static let customFileName = "custom-devices.json"
    public static let overrideFileName = "devices.json"
    /// Version written into catalog files.
    public static let fileFormatVersion = 1

    /// `~/Library/Application Support/NetSketch`.
    public static var defaultSupportDirectory: URL {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
            ?? URL(fileURLWithPath: NSHomeDirectory()).appendingPathComponent("Library/Application Support")
        return base.appendingPathComponent("NetSketch", isDirectory: true)
    }

    /// Built-in (or override) templates, in file order.
    public private(set) var builtIn: [DeviceTemplate] = []
    /// User templates, in the order they were added.
    public private(set) var custom: [DeviceTemplate] = []
    public private(set) var builtInSource: BuiltInSource = .bundle
    /// Problems met while loading (unreadable override or custom file, duplicate ids).
    /// Diagnostic English text; empty when everything loaded cleanly.
    public private(set) var loadIssues: [String] = []
    /// Directory of the override and custom files; nil means memory only.
    public let supportDirectory: URL?

    @ObservationIgnored private var customFileUnreadable = false

    /// Loads the bundled catalog (or the override file) and the custom templates.
    public init(supportDirectory: URL? = DeviceCatalog.defaultSupportDirectory) {
        self.supportDirectory = supportDirectory
        reload()
    }

    /// A catalog with explicit contents (tests, previews). Custom templates are still
    /// persisted when a support directory is given.
    public init(builtIn: [DeviceTemplate], custom: [DeviceTemplate] = [], supportDirectory: URL? = nil) {
        self.supportDirectory = supportDirectory
        self.builtIn = builtIn.map { DeviceCatalog.prepared($0, isCustom: false) }
        self.custom = custom.map { DeviceCatalog.prepared($0, isCustom: true) }
        self.builtInSource = .provided
    }

    // MARK: Lookup

    /// Built-in templates followed by custom ones.
    public var templates: [DeviceTemplate] { builtIn + custom }

    public func template(id: String) -> DeviceTemplate? {
        builtIn.first { $0.id == id } ?? custom.first { $0.id == id }
    }

    public func templates(in category: DeviceCategory) -> [DeviceTemplate] {
        templates.filter { $0.category == category }
    }

    /// Templates grouped by category in `DeviceCategory.allCases` order; empty categories are omitted.
    public var templatesByCategory: [TemplateGroup] {
        DeviceCategory.allCases.compactMap { category in
            let members = templates(in: category)
            return members.isEmpty ? nil : TemplateGroup(category: category, templates: members)
        }
    }

    /// An id derived from vendor and model that no template uses yet ("acme-x1", "acme-x1-2", ...).
    public func uniqueID(vendor: String, model: String) -> String {
        let base = DeviceTemplate.slug(vendor: vendor, model: model)
        var candidate = base
        var counter = 2
        while template(id: candidate) != nil {
            candidate = "\(base)-\(counter)"
            counter += 1
        }
        return candidate
    }

    // MARK: Files

    /// `<support>/custom-devices.json`, nil for a memory-only catalog.
    public var customFileURL: URL? { supportDirectory?.appendingPathComponent(DeviceCatalog.customFileName) }

    /// `<support>/devices.json`, nil for a memory-only catalog.
    public var overrideFileURL: URL? { supportDirectory?.appendingPathComponent(DeviceCatalog.overrideFileName) }

    /// Re-reads the built-in catalog (override file first, bundle otherwise) and the custom file.
    public func reload() {
        var issues: [String] = []
        var loaded: [DeviceTemplate]?
        var source = BuiltInSource.bundle

        if let url = overrideFileURL, FileManager.default.fileExists(atPath: url.path) {
            do {
                loaded = try DeviceCatalog.loadTemplates(from: url)
                source = .overrideFile(url)
            } catch {
                issues.append("Override catalog \(url.path) is unreadable, using the bundled one: \(error)")
            }
        }
        if loaded == nil {
            do {
                loaded = try DeviceCatalog.bundledTemplates()
            } catch {
                issues.append("Bundled devices.json is unreadable: \(error)")
            }
        }
        builtIn = DeviceCatalog.unique(loaded ?? [], isCustom: false, taken: [], issues: &issues)
        builtInSource = source

        var customLoaded: [DeviceTemplate] = []
        customFileUnreadable = false
        if let url = customFileURL, FileManager.default.fileExists(atPath: url.path) {
            do {
                customLoaded = try DeviceCatalog.loadTemplates(from: url)
            } catch {
                customFileUnreadable = true
                issues.append("Custom catalog \(url.path) is unreadable and was ignored: \(error)")
            }
        }
        custom = DeviceCatalog.unique(customLoaded, isCustom: true, taken: Set(builtIn.map(\.id)), issues: &issues)
        loadIssues = issues
    }

    /// Replaces the built-in templates with the contents of a catalog JSON document.
    public func loadBuiltIn(from data: Data) throws {
        var issues: [String] = []
        builtIn = DeviceCatalog.unique(try DeviceCatalog.decodeTemplates(from: data), isCustom: false, taken: [], issues: &issues)
        builtInSource = .provided
        custom.removeAll { candidate in builtIn.contains { $0.id == candidate.id } }
        loadIssues.append(contentsOf: issues)
    }

    /// Replaces the built-in templates with the contents of a catalog JSON file.
    public func loadBuiltIn(from url: URL) throws {
        try loadBuiltIn(from: try Data(contentsOf: url))
    }

    /// Decodes templates from catalog JSON (`{"templates": [...]}` or a bare array).
    public static func decodeTemplates(from data: Data) throws -> [DeviceTemplate] {
        let decoder = JSONDecoder()
        do {
            return try decoder.decode(CatalogFile.self, from: data).templates
        } catch {
            if let bare = try? decoder.decode([DeviceTemplate].self, from: data) { return bare }
            throw error
        }
    }

    /// Reads and decodes a catalog JSON file.
    public static func loadTemplates(from url: URL) throws -> [DeviceTemplate] {
        try decodeTemplates(from: try Data(contentsOf: url))
    }

    /// Encodes templates as a catalog JSON document (pretty-printed, sorted keys).
    public static func encodeTemplates(_ templates: [DeviceTemplate]) throws -> Data {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
        return try encoder.encode(CatalogFile(formatVersion: fileFormatVersion, templates: templates))
    }

    /// The templates of the devices.json bundled with NetSketchCore.
    public static func bundledTemplates() throws -> [DeviceTemplate] {
        guard let url = bundledDevicesURL else {
            throw CocoaError(.fileNoSuchFile, userInfo: [NSFilePathErrorKey: "devices.json"])
        }
        return try loadTemplates(from: url)
    }

    /// Location of the bundled devices.json.
    ///
    /// Looked up in the SwiftPM resource bundle `NetSketch_NetSketchCore.bundle` inside the
    /// app's `Contents/Resources`, next to the app bundle or next to the executable, then as a
    /// loose `devices.json` in the main bundle, and finally through `Bundle.module`
    /// (which also knows the build directory). A hand-assembled .app therefore only has to
    /// copy the resource bundle into `Contents/Resources`.
    public static var bundledDevicesURL: URL? {
        let bundleName = "NetSketch_NetSketchCore.bundle"
        var directories: [URL] = []
        if let resources = Bundle.main.resourceURL { directories.append(resources) }
        directories.append(Bundle.main.bundleURL)
        if let executable = Bundle.main.executableURL { directories.append(executable.deletingLastPathComponent()) }

        for directory in directories {
            let candidate = directory.appendingPathComponent(bundleName)
            if let bundle = Bundle(url: candidate),
               let url = bundle.url(forResource: "devices", withExtension: "json") {
                return url
            }
            let loose = candidate.appendingPathComponent("devices.json")
            if FileManager.default.fileExists(atPath: loose.path) { return loose }
        }
        if let loose = Bundle.main.url(forResource: "devices", withExtension: "json") { return loose }
        return Bundle.module.url(forResource: "devices", withExtension: "json")
    }

    // MARK: Custom templates

    /// Adds a user template and saves the custom file.
    ///
    /// The stored copy has `isCustom == true` and a normalized layout; an empty id is replaced
    /// by `uniqueID(vendor:model:)`. Throws `CatalogError.duplicateID` when the id is taken and
    /// `.invalidTemplate` when the model name is empty; file errors are rethrown.
    @discardableResult
    public func addCustom(_ template: DeviceTemplate) throws -> DeviceTemplate {
        var entry = try DeviceCatalog.validated(template)
        if entry.id.trimmingCharacters(in: .whitespaces).isEmpty {
            entry.id = uniqueID(vendor: entry.vendor, model: entry.model)
        }
        guard self.template(id: entry.id) == nil else { throw CatalogError.duplicateID(entry.id) }
        try replaceCustom(with: custom + [entry])
        return entry
    }

    /// Replaces the custom template with the same id and saves the custom file.
    /// Devices already placed keep their own snapshot and are not affected.
    @discardableResult
    public func updateCustom(_ template: DeviceTemplate) throws -> DeviceTemplate {
        let entry = try DeviceCatalog.validated(template)
        guard let index = custom.firstIndex(where: { $0.id == entry.id }) else {
            throw builtIn.contains { $0.id == entry.id }
                ? CatalogError.notCustom(entry.id)
                : CatalogError.unknownTemplate(entry.id)
        }
        var updated = custom
        updated[index] = entry
        try replaceCustom(with: updated)
        return entry
    }

    /// Removes a custom template and saves the custom file.
    public func removeCustom(id: String) throws {
        guard custom.contains(where: { $0.id == id }) else {
            throw builtIn.contains { $0.id == id } ? CatalogError.notCustom(id) : CatalogError.unknownTemplate(id)
        }
        try replaceCustom(with: custom.filter { $0.id != id })
    }

    /// Writes first, then publishes, so a failed save leaves the catalog unchanged.
    private func replaceCustom(with updated: [DeviceTemplate]) throws {
        if let url = customFileURL {
            let manager = FileManager.default
            try manager.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
            if customFileUnreadable, manager.fileExists(atPath: url.path) {
                // Keep the user's unreadable file instead of silently overwriting it.
                let backup = url.deletingLastPathComponent().appendingPathComponent("custom-devices.invalid.json")
                try? manager.removeItem(at: backup)
                try manager.copyItem(at: url, to: backup)
            }
            try DeviceCatalog.encodeTemplates(updated).write(to: url, options: .atomic)
            customFileUnreadable = false
        }
        custom = updated
    }

    // MARK: Helpers

    private static func prepared(_ template: DeviceTemplate, isCustom: Bool) -> DeviceTemplate {
        var entry = template
        entry.isCustom = isCustom
        entry.normalizeLayout()
        return entry
    }

    private static func validated(_ template: DeviceTemplate) throws -> DeviceTemplate {
        guard !template.model.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            throw CatalogError.invalidTemplate("model is empty")
        }
        return prepared(template, isCustom: true)
    }

    private static func unique(
        _ templates: [DeviceTemplate],
        isCustom: Bool,
        taken: Set<String>,
        issues: inout [String]
    ) -> [DeviceTemplate] {
        var seen = taken
        var result: [DeviceTemplate] = []
        for template in templates {
            guard seen.insert(template.id).inserted else {
                issues.append("Duplicate template id \"\(template.id)\" was ignored.")
                continue
            }
            result.append(prepared(template, isCustom: isCustom))
        }
        return result
    }

    private struct CatalogFile: Codable {
        var formatVersion: Int
        var templates: [DeviceTemplate]

        init(formatVersion: Int, templates: [DeviceTemplate]) {
            self.formatVersion = formatVersion
            self.templates = templates
        }

        private enum CodingKeys: String, CodingKey { case formatVersion, templates }

        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            formatVersion = try c.decodeIfPresent(Int.self, forKey: .formatVersion) ?? 1
            templates = try c.decode([DeviceTemplate].self, forKey: .templates)
        }
    }
}
