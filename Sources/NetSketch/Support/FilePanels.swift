import AppKit
import UniformTypeIdentifiers

/// File types and the open/save panels used by the document commands.
enum FilePanels {
    static let projectExtension = "netsketch"

    /// The project file type.
    ///
    /// A bare SwiftPM executable has no Info.plist, so the type cannot be declared there and is
    /// derived from the filename extension instead. It must stay the plain (data-conforming) variant:
    /// a `conformingTo: .json` dynamic type is a different identifier than the one the system assigns
    /// to `*.netsketch` files, and the open panel would then grey those files out.
    /// Inside `NetSketch.app` the same call resolves to the type exported by the bundle's Info.plist.
    static let projectType: UTType = UTType(filenameExtension: projectExtension) ?? .json

    /// Asks for a project file to open. Returns nil when cancelled.
    static func chooseProjectToOpen() -> URL? {
        let panel = NSOpenPanel()
        panel.title = "Otevřít projekt"
        panel.prompt = "Otevřít"
        panel.allowedContentTypes = [projectType, .json]
        panel.allowsMultipleSelection = false
        panel.canChooseDirectories = false
        panel.canChooseFiles = true
        return panel.runModal() == .OK ? panel.url : nil
    }

    /// Asks where to save the project. Returns nil when cancelled.
    static func chooseProjectDestination(suggestedName: String, directory: URL?) -> URL? {
        let panel = NSSavePanel()
        panel.title = "Uložit projekt"
        panel.prompt = "Uložit"
        panel.allowedContentTypes = [projectType]
        panel.allowsOtherFileTypes = false
        panel.canCreateDirectories = true
        panel.isExtensionHidden = false
        panel.nameFieldStringValue = withExtension(suggestedName, projectExtension)
        if let directory { panel.directoryURL = directory }
        guard panel.runModal() == .OK, let url = panel.url else { return nil }
        return ensureExtension(url, projectExtension)
    }

    /// Asks where to write an exported image or PDF. Returns nil when cancelled.
    static func chooseExportDestination(suggestedName: String, type: UTType, title: String) -> URL? {
        let panel = NSSavePanel()
        panel.title = title
        panel.prompt = "Exportovat"
        panel.allowedContentTypes = [type]
        panel.allowsOtherFileTypes = false
        panel.canCreateDirectories = true
        panel.isExtensionHidden = false
        let ext = type.preferredFilenameExtension ?? ""
        panel.nameFieldStringValue = withExtension(suggestedName, ext)
        guard panel.runModal() == .OK, let url = panel.url else { return nil }
        return ext.isEmpty ? url : ensureExtension(url, ext)
    }

    /// `name` ending in `.ext`. Other dots are left alone ("Cvičení 3.1" stays a name, not an extension).
    static func withExtension(_ name: String, _ ext: String) -> String {
        guard !ext.isEmpty else { return name }
        return name.lowercased().hasSuffix("." + ext.lowercased()) ? name : name + "." + ext
    }

    private static func ensureExtension(_ url: URL, _ ext: String) -> URL {
        url.pathExtension.lowercased() == ext.lowercased() ? url : url.appendingPathExtension(ext)
    }
}
