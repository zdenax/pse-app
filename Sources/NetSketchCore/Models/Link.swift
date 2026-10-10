import Foundation
import CoreGraphics

/// Reference to one port of one device.
public struct PortRef: Codable, Equatable, Hashable, Sendable {
    public var deviceID: UUID
    public var portID: UUID

    public init(deviceID: UUID, portID: UUID) {
        self.deviceID = deviceID
        self.portID = portID
    }
}

/// An unordered pair of devices; equal regardless of the order the two ids were given in.
public struct DevicePair: Equatable, Hashable, Sendable {
    public let first: UUID
    public let second: UUID

    public init(_ x: UUID, _ y: UUID) {
        if x.uuidString <= y.uuidString {
            first = x
            second = y
        } else {
            first = y
            second = x
        }
    }

    public func contains(_ deviceID: UUID) -> Bool { first == deviceID || second == deviceID }
}

/// A cable between two ports.
///
/// Decoding is lenient: `cableType`, `statusA`, `statusB`, `note` and `bundleID` may be missing.
public struct Link: Codable, Identifiable, Equatable, Hashable, Sendable {
    public var id: UUID
    public var a: PortRef
    public var b: PortRef
    public var cableType: CableType
    /// Status dot at end `a`. Manual toggle only.
    public var statusA: LinkStatus
    /// Status dot at end `b`. Manual toggle only.
    public var statusB: LinkStatus
    public var note: String
    /// The bundle (LAG) this link is drawn as part of, if any.
    public var bundleID: UUID?

    public init(
        id: UUID = UUID(),
        a: PortRef,
        b: PortRef,
        cableType: CableType = .straight,
        statusA: LinkStatus = .none,
        statusB: LinkStatus = .none,
        note: String = "",
        bundleID: UUID? = nil
    ) {
        self.id = id
        self.a = a
        self.b = b
        self.cableType = cableType
        self.statusA = statusA
        self.statusB = statusB
        self.note = note
        self.bundleID = bundleID
    }

    /// The port at the given end.
    public func ref(_ end: LinkEnd) -> PortRef { end == .a ? a : b }

    /// The status dot at the given end.
    public func status(_ end: LinkEnd) -> LinkStatus { end == .a ? statusA : statusB }

    /// Which end is plugged into `ref`, if either.
    public func end(at ref: PortRef) -> LinkEnd? {
        if a == ref { return .a }
        if b == ref { return .b }
        return nil
    }

    /// Which end sits on the device, if either.
    public func end(onDevice deviceID: UUID) -> LinkEnd? {
        if a.deviceID == deviceID { return .a }
        if b.deviceID == deviceID { return .b }
        return nil
    }

    /// The port at the other end from `ref`; nil when `ref` is not an end of this link.
    public func otherEnd(from ref: PortRef) -> PortRef? {
        if a == ref { return b }
        if b == ref { return a }
        return nil
    }

    public func touches(deviceID: UUID) -> Bool { a.deviceID == deviceID || b.deviceID == deviceID }

    /// The two devices the link connects, order-independent (for grouping parallel links).
    public var devicePair: DevicePair { DevicePair(a.deviceID, b.deviceID) }

    private enum CodingKeys: String, CodingKey {
        case id, a, b, cableType, statusA, statusB, note, bundleID
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(UUID.self, forKey: .id)
        a = try c.decode(PortRef.self, forKey: .a)
        b = try c.decode(PortRef.self, forKey: .b)
        cableType = try c.decodeIfPresent(CableType.self, forKey: .cableType) ?? .straight
        statusA = try c.decodeIfPresent(LinkStatus.self, forKey: .statusA) ?? .none
        statusB = try c.decodeIfPresent(LinkStatus.self, forKey: .statusB) ?? .none
        note = try c.decodeIfPresent(String.self, forKey: .note) ?? ""
        bundleID = try c.decodeIfPresent(UUID.self, forKey: .bundleID)
    }
}

/// Unambiguous name for `Port` in files that also import Foundation, where `Port` alone
/// collides with `Foundation.Port` (NSPort).
public typealias NetPort = Port

/// Unambiguous name for `Link` in files that also import SwiftUI, where `Link` alone
/// collides with `SwiftUI.Link`.
public typealias NetLink = Link

/// A visual grouping of parallel links (LAG / port-channel / bond). No logic is attached.
public struct LinkBundle: Codable, Identifiable, Equatable, Hashable, Sendable {
    public var id: UUID
    /// Caption drawn next to the bundle, e.g. "Po1 / bond1".
    public var label: String
    /// Member links (two or more, all between the same pair of devices).
    public var linkIDs: [UUID]

    public init(id: UUID = UUID(), label: String, linkIDs: [UUID]) {
        self.id = id
        self.label = label
        self.linkIDs = linkIDs
    }
}

/// A free text label on the canvas.
public struct Annotation: Codable, Identifiable, Equatable, Hashable, Sendable {
    public var id: UUID
    public var text: String
    /// Top-leading corner of the text in canvas coordinates.
    public var position: CGPoint

    public init(id: UUID = UUID(), text: String, position: CGPoint) {
        self.id = id
        self.text = text
        self.position = position
    }

    public func hash(into hasher: inout Hasher) { hasher.combine(id) }

    private enum CodingKeys: String, CodingKey { case id, text, position }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(UUID.self, forKey: .id)
        text = try c.decodeIfPresent(String.self, forKey: .text) ?? ""
        position = try c.decode(CodablePoint.self, forKey: .position).point
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(id, forKey: .id)
        try c.encode(text, forKey: .text)
        try c.encode(CodablePoint(position), forKey: .position)
    }
}

/// What is plugged into the far end of a cable.
public struct PortPeer: Equatable, Sendable {
    /// The cable.
    public let link: Link
    /// The end of `link` at which the peer sits.
    public let end: LinkEnd
    /// Reference to the peer port.
    public let ref: PortRef
    /// The device at the far end.
    public let device: Device
    /// The port at the far end.
    public let port: Port

    public init(link: Link, end: LinkEnd, ref: PortRef, device: Device, port: Port) {
        self.link = link
        self.end = end
        self.ref = ref
        self.device = device
        self.port = port
    }
}

/// One row of a device's "what is plugged where" list.
public struct PortConnection: Identifiable, Equatable, Sendable {
    /// The local port.
    public let port: Port
    /// The cable in the port, nil when the port is free.
    public let link: Link?
    /// The far end of the cable, nil when the port is free.
    public let peer: PortPeer?

    public var id: UUID { port.id }

    public init(port: Port, link: Link?, peer: PortPeer?) {
        self.port = port
        self.link = link
        self.peer = peer
    }
}
