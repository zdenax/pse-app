import Foundation
import CoreGraphics

/// Errors raised when reading a project file.
public enum ProjectFileError: Error, Equatable, Sendable {
    /// The file was written by a newer version of the app.
    case unsupportedFormatVersion(found: Int, supported: Int)
}

/// An internal inconsistency found by `Project.validate()`.
public enum ProjectIssue: Equatable, Hashable, Sendable {
    /// Two devices, links, bundles or annotations share an id (or two ports of one device do).
    case duplicateID(UUID)
    /// A link end points at a device or port that does not exist.
    case danglingPortRef(linkID: UUID, end: LinkEnd)
    /// Both ends of a link are on the same device.
    case linkWithinDevice(linkID: UUID)
    /// More than one link is plugged into the port.
    case portUsedTwice(PortRef)
    /// A bundle lists a link that does not exist.
    case bundleMissingLink(bundleID: UUID, linkID: UUID)
    /// A bundle has fewer than two member links.
    case bundleTooSmall(bundleID: UUID)
    /// The members of a bundle do not all connect the same pair of devices.
    case bundleNotParallel(bundleID: UUID)
    /// `Link.bundleID` and `LinkBundle.linkIDs` disagree about this link.
    case bundleMembershipMismatch(linkID: UUID)
}

/// A whole document: devices, cables, bundles and text labels.
///
/// Stored as pretty-printed JSON with sorted keys in a ".netsketch" file.
/// Decoding is lenient about missing `name`, `links`, `bundles`, `annotations` and `viewMode`.
public struct Project: Codable, Equatable, Sendable {
    /// File-format version written by this build.
    public static let currentFormatVersion = 1
    /// File extension without the dot.
    public static let fileExtension = "netsketch"

    public var formatVersion: Int
    public var name: String
    public var devices: [Device]
    public var links: [Link]
    public var bundles: [LinkBundle]
    public var annotations: [Annotation]
    /// Last used view mode; nil in files that never stored one.
    public var viewMode: ViewMode?

    public init(
        name: String = "",
        devices: [Device] = [],
        links: [Link] = [],
        bundles: [LinkBundle] = [],
        annotations: [Annotation] = [],
        viewMode: ViewMode? = nil
    ) {
        self.formatVersion = Project.currentFormatVersion
        self.name = name
        self.devices = devices
        self.links = links
        self.bundles = bundles
        self.annotations = annotations
        self.viewMode = viewMode
    }

    // MARK: Codable and files

    private enum CodingKeys: String, CodingKey {
        case formatVersion, name, devices, links, bundles, annotations, viewMode
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        formatVersion = try c.decodeIfPresent(Int.self, forKey: .formatVersion) ?? 1
        guard formatVersion <= Project.currentFormatVersion else {
            throw ProjectFileError.unsupportedFormatVersion(
                found: formatVersion,
                supported: Project.currentFormatVersion
            )
        }
        name = try c.decodeIfPresent(String.self, forKey: .name) ?? ""
        devices = try c.decodeIfPresent([Device].self, forKey: .devices) ?? []
        links = try c.decodeIfPresent([Link].self, forKey: .links) ?? []
        bundles = try c.decodeIfPresent([LinkBundle].self, forKey: .bundles) ?? []
        annotations = try c.decodeIfPresent([Annotation].self, forKey: .annotations) ?? []
        viewMode = try c.decodeIfPresent(ViewMode.self, forKey: .viewMode)
    }

    /// Decodes a project from JSON. Throws `DecodingError` or `ProjectFileError`.
    /// The result is not validated; see `validate()` and `repaired()`.
    public init(data: Data) throws {
        self = try JSONDecoder().decode(Project.self, from: data)
    }

    /// Pretty-printed JSON with sorted keys (stable diffs, hand-editable).
    public func encoded() throws -> Data {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
        return try encoder.encode(self)
    }

    /// Reads and decodes a ".netsketch" file.
    public static func load(from url: URL) throws -> Project {
        try Project(data: try Data(contentsOf: url))
    }

    /// Encodes and writes the project atomically.
    public func save(to url: URL) throws {
        try encoded().write(to: url, options: .atomic)
    }

    // MARK: Lookups

    public func device(id: UUID) -> Device? { devices.first { $0.id == id } }

    /// The first device with this hostname (hostnames are not required to be unique).
    public func device(hostname: String) -> Device? { devices.first { $0.hostname == hostname } }

    public func port(_ ref: PortRef) -> Port? { device(id: ref.deviceID)?.port(id: ref.portID) }

    /// The device and port a reference points at, or nil when either is missing.
    public func resolve(_ ref: PortRef) -> (device: Device, port: Port)? {
        guard let device = device(id: ref.deviceID), let port = device.port(id: ref.portID) else { return nil }
        return (device, port)
    }

    public func link(id: UUID) -> Link? { links.first { $0.id == id } }

    /// The cable plugged into the port, if any.
    public func link(at ref: PortRef) -> Link? { links.first { $0.a == ref || $0.b == ref } }

    public func isPortUsed(_ ref: PortRef) -> Bool { link(at: ref) != nil }

    /// All cables with at least one end on the device.
    public func links(ofDevice deviceID: UUID) -> [Link] { links.filter { $0.touches(deviceID: deviceID) } }

    /// All cables between two devices, in either direction.
    public func links(between first: UUID, and second: UUID) -> [Link] {
        let pair = DevicePair(first, second)
        return links.filter { $0.devicePair == pair }
    }

    /// The device and port at the other end of the cable plugged into `ref`.
    public func peer(of ref: PortRef) -> PortPeer? {
        guard let link = link(at: ref),
              let end = link.end(at: ref)?.opposite,
              let far = resolve(link.ref(end))
        else { return nil }
        return PortPeer(link: link, end: end, ref: link.ref(end), device: far.device, port: far.port)
    }

    /// Every port of the device with what is plugged into it, in port order.
    public func connections(ofDevice deviceID: UUID) -> [PortConnection] {
        guard let device = device(id: deviceID) else { return [] }
        return device.ports.map { port in
            let ref = PortRef(deviceID: deviceID, portID: port.id)
            return PortConnection(port: port, link: link(at: ref), peer: peer(of: ref))
        }
    }

    public func bundle(id: UUID) -> LinkBundle? { bundles.first { $0.id == id } }

    /// The bundle the link belongs to, if any.
    public func bundle(ofLink linkID: UUID) -> LinkBundle? { bundles.first { $0.linkIDs.contains(linkID) } }

    public func annotation(id: UUID) -> Annotation? { annotations.first { $0.id == id } }

    // MARK: Consistency

    /// Checks internal consistency. An empty result means every `PortRef` resolves,
    /// no port carries two cables and bundles agree with their links.
    public func validate() -> [ProjectIssue] {
        var issues: [ProjectIssue] = []

        var ids = Set<UUID>()
        func check(_ id: UUID) {
            if !ids.insert(id).inserted { issues.append(.duplicateID(id)) }
        }
        for device in devices {
            check(device.id)
            var portIDs = Set<UUID>()
            for port in device.ports where !portIDs.insert(port.id).inserted {
                issues.append(.duplicateID(port.id))
            }
        }
        links.forEach { check($0.id) }
        bundles.forEach { check($0.id) }
        annotations.forEach { check($0.id) }

        var usedPorts = Set<PortRef>()
        for link in links {
            for end in LinkEnd.allCases {
                let ref = link.ref(end)
                if port(ref) == nil {
                    issues.append(.danglingPortRef(linkID: link.id, end: end))
                } else if !usedPorts.insert(ref).inserted {
                    issues.append(.portUsedTwice(ref))
                }
            }
            if link.a.deviceID == link.b.deviceID {
                issues.append(.linkWithinDevice(linkID: link.id))
            }
        }

        var membership: [UUID: UUID] = [:]
        for bundle in bundles {
            var pairs = Set<DevicePair>()
            var members = 0
            for linkID in bundle.linkIDs {
                guard let link = link(id: linkID) else {
                    issues.append(.bundleMissingLink(bundleID: bundle.id, linkID: linkID))
                    continue
                }
                members += 1
                pairs.insert(link.devicePair)
                if membership.updateValue(bundle.id, forKey: linkID) != nil {
                    issues.append(.bundleMembershipMismatch(linkID: linkID))
                }
            }
            if members < 2 { issues.append(.bundleTooSmall(bundleID: bundle.id)) }
            if pairs.count > 1 { issues.append(.bundleNotParallel(bundleID: bundle.id)) }
        }
        for link in links where link.bundleID != membership[link.id] {
            issues.append(.bundleMembershipMismatch(linkID: link.id))
        }
        return issues
    }

    /// A consistent copy: duplicate ids, broken links and broken bundles are dropped
    /// (the first occurrence wins). `repaired().validate()` is always empty.
    public func repaired() -> Project {
        var result = self

        var ids = Set<UUID>()
        result.devices = devices.compactMap { device in
            guard ids.insert(device.id).inserted else { return nil }
            var device = device
            var portIDs = Set<UUID>()
            device.ports = device.ports.filter { portIDs.insert($0.id).inserted }
            return device
        }
        result.annotations = annotations.filter { ids.insert($0.id).inserted }

        var usedPorts = Set<PortRef>()
        result.links = links.filter { link in
            guard !ids.contains(link.id),
                  link.a.deviceID != link.b.deviceID,
                  result.port(link.a) != nil, result.port(link.b) != nil,
                  !usedPorts.contains(link.a), !usedPorts.contains(link.b)
            else { return false }
            ids.insert(link.id)
            usedPorts.insert(link.a)
            usedPorts.insert(link.b)
            return true
        }

        var membership: [UUID: UUID] = [:]
        result.bundles = bundles.compactMap { bundle in
            guard !ids.contains(bundle.id) else { return nil }
            var pair: DevicePair?
            var members: [UUID] = []
            for linkID in bundle.linkIDs {
                guard membership[linkID] == nil, !members.contains(linkID),
                      let link = result.link(id: linkID)
                else { continue }
                if let pair, pair != link.devicePair { continue }
                pair = link.devicePair
                members.append(linkID)
            }
            guard members.count >= 2 else { return nil }
            ids.insert(bundle.id)
            members.forEach { membership[$0] = bundle.id }
            var bundle = bundle
            bundle.linkIDs = members
            return bundle
        }
        for index in result.links.indices {
            result.links[index].bundleID = membership[result.links[index].id]
        }
        return result
    }
}
