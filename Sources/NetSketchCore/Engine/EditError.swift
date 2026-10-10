import Foundation

/// Why an editing operation on `ProjectStore` was refused. The project is unchanged when
/// an operation throws. The core carries no user-facing texts; map the cases in the UI.
public enum EditError: Error, Equatable, Hashable, Sendable {
    /// No catalog template has this id.
    case unknownTemplate(String)
    case unknownDevice(UUID)
    /// The device or the port of this reference does not exist.
    case unknownPort(PortRef)
    case unknownLink(UUID)
    case unknownBundle(UUID)
    case unknownAnnotation(UUID)
    /// Both ends of a new cable are the same port.
    case samePort
    /// Both ends of a new cable are on the same device.
    case sameDevice
    /// The port already has a cable.
    case portInUse(PortRef)
    /// A bundle needs at least two distinct links.
    case bundleNeedsTwoLinks
    /// The links of a bundle must all connect the same pair of devices.
    case bundleLinksNotParallel
    /// The link already belongs to another bundle.
    case linkAlreadyBundled(UUID)
    /// A hostname or bundle label must not be empty.
    case emptyName
    /// `save()` was called on a project that has never been saved; use `save(to:)`.
    case noFileURL
}
