import Foundation
import CoreGraphics

/// A catalog entry: a device model with its port groups and front-panel layout.
///
/// JSON keys: `id`, `vendor`, `model`, `category`, `portGroups`, `layout` (optional; derived
/// automatically when missing), `verified` (default false), `note` (optional),
/// `isCustom` (default false; the catalog overrides it).
public struct DeviceTemplate: Codable, Identifiable, Equatable, Hashable, Sendable {
    /// Stable slug, e.g. "cisco-catalyst-2960-24". Stored in devices as `templateID`.
    public var id: String
    /// Vendor as plain text. No logos.
    public var vendor: String
    public var model: String
    public var category: DeviceCategory
    public var portGroups: [PortGroup]
    /// Front-panel layout. Call `normalizeLayout()` after editing `portGroups` by hand.
    public var layout: PanelLayout
    /// False until the whole template has been checked against real hardware.
    public var verified: Bool
    public var note: String?
    /// True for user-defined templates (stored in custom-devices.json).
    public var isCustom: Bool

    /// - Parameters:
    ///   - id: slug; derived from vendor and model when nil or empty.
    ///   - layout: front panel; derived from the port groups when nil.
    public init(
        id: String? = nil,
        vendor: String,
        model: String,
        category: DeviceCategory,
        portGroups: [PortGroup],
        layout: PanelLayout? = nil,
        verified: Bool = false,
        note: String? = nil,
        isCustom: Bool = false
    ) {
        let given = id?.trimmingCharacters(in: .whitespaces) ?? ""
        self.id = given.isEmpty ? DeviceTemplate.slug(vendor: vendor, model: model) : given
        self.vendor = vendor
        self.model = model
        self.category = category
        self.portGroups = portGroups
        self.layout = (layout ?? .automatic(for: portGroups)).normalized(for: portGroups)
        self.verified = verified
        self.note = note
        self.isCustom = isCustom
    }

    /// "Vendor Model".
    public var displayName: String {
        [vendor, model].filter { !$0.isEmpty }.joined(separator: " ")
    }

    /// Total number of ports.
    public var portCount: Int { portGroups.reduce(0) { $0 + $1.portCount } }

    /// True when the template or any of its port groups is still unverified
    /// (the UI shows the "ověřit podle hardwaru" warning).
    public var needsVerification: Bool {
        !verified || portGroups.contains { !$0.verified }
    }

    /// Re-derives a consistent layout after `portGroups` changed.
    public mutating func normalizeLayout() {
        layout = layout.normalized(for: portGroups)
    }

    /// Fresh ports (new UUIDs) for a new device, in group order.
    public func makePorts() -> [Port] {
        var ports: [Port] = []
        for (groupIndex, group) in portGroups.enumerated() {
            for name in group.portNames {
                ports.append(Port(
                    name: name,
                    connector: group.connector,
                    speed: group.speed,
                    verified: group.verified,
                    groupIndex: groupIndex
                ))
            }
        }
        return ports
    }

    /// A new device instance carrying a snapshot of this template's ports and layout.
    public func makeDevice(hostname: String, at position: CGPoint) -> Device {
        Device(
            templateID: id,
            vendor: vendor,
            model: model,
            category: category,
            hostname: hostname,
            position: position,
            ports: makePorts(),
            layout: layout.normalized(for: portGroups),
            verified: verified
        )
    }

    /// Front panel of the template in cell units (for palette previews).
    public var panelGrid: PanelGrid {
        var indices: [Int] = []
        for (groupIndex, group) in portGroups.enumerated() {
            indices.append(contentsOf: Array(repeating: groupIndex, count: group.portCount))
        }
        return layout.normalized(for: portGroups).grid(groupIndices: indices)
    }

    /// Lowercase ASCII slug: "Dell EMC" + "S3048-ON" -> "dell-emc-s3048-on".
    public static func slug(vendor: String, model: String) -> String {
        let folded = "\(vendor) \(model)"
            .folding(options: [.diacriticInsensitive, .caseInsensitive], locale: Locale(identifier: "en_US_POSIX"))
            .lowercased()
        var slug = ""
        var pendingDash = false
        for scalar in folded.unicodeScalars {
            let isAlphanumeric = ("a"..."z").contains(scalar) || ("0"..."9").contains(scalar)
            if isAlphanumeric {
                if pendingDash, !slug.isEmpty { slug.append("-") }
                slug.unicodeScalars.append(scalar)
                pendingDash = false
            } else {
                pendingDash = true
            }
        }
        return slug.isEmpty ? "device" : slug
    }

    // MARK: Codable

    private enum CodingKeys: String, CodingKey {
        case id, vendor, model, category, portGroups, layout, verified, note, isCustom
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let vendor = try c.decodeIfPresent(String.self, forKey: .vendor) ?? ""
        let model = try c.decode(String.self, forKey: .model)
        let groups = try c.decodeIfPresent([PortGroup].self, forKey: .portGroups) ?? []
        self.init(
            id: try c.decodeIfPresent(String.self, forKey: .id),
            vendor: vendor,
            model: model,
            category: try c.decode(DeviceCategory.self, forKey: .category),
            portGroups: groups,
            layout: try c.decodeIfPresent(PanelLayout.self, forKey: .layout),
            verified: try c.decodeIfPresent(Bool.self, forKey: .verified) ?? false,
            note: try c.decodeIfPresent(String.self, forKey: .note),
            isCustom: try c.decodeIfPresent(Bool.self, forKey: .isCustom) ?? false
        )
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(id, forKey: .id)
        try c.encode(vendor, forKey: .vendor)
        try c.encode(model, forKey: .model)
        try c.encode(category, forKey: .category)
        try c.encode(portGroups, forKey: .portGroups)
        try c.encode(layout, forKey: .layout)
        try c.encode(verified, forKey: .verified)
        try c.encodeIfPresent(note, forKey: .note)
        try c.encode(isCustom, forKey: .isCustom)
    }
}
