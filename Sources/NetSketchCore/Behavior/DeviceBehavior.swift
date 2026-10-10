import Foundation

/// Extension point for per-device logic: a configuration CLI today, STP / LACP / VLAN
/// simulation some day.
///
/// The core does NOTHING with it: every requirement has an empty default implementation,
/// `DefaultDeviceBehavior` adds nothing, and `ProjectStore` never calls a behavior on its own.
/// A higher layer (e.g. the CLI target) registers its implementation in
/// `ProjectStore.behaviors` and calls it itself. NetSketch core contains no protocol simulation.
public protocol DeviceBehavior {
    /// The device was placed on the canvas.
    func deviceDidAdd(_ device: Device, in project: Project)

    /// A cable on one of the device's ports was connected or changed.
    func linkDidChange(_ link: Link, on device: Device, in project: Project)

    /// A cable was unplugged from one of the device's ports.
    func linkDidRemove(_ link: Link, on device: Device, in project: Project)

    /// Handles one command line typed for the device.
    /// Returns the text to print, or nil when the command is not handled.
    func handleCommand(_ command: String, on device: Device, in store: ProjectStore) -> String?
}

public extension DeviceBehavior {
    func deviceDidAdd(_ device: Device, in project: Project) {}
    func linkDidChange(_ link: Link, on device: Device, in project: Project) {}
    func linkDidRemove(_ link: Link, on device: Device, in project: Project) {}
    func handleCommand(_ command: String, on device: Device, in store: ProjectStore) -> String? { nil }
}

/// The behavior every device has unless something else is registered. It does nothing.
public struct DefaultDeviceBehavior: DeviceBehavior {
    public init() {}
}

/// Maps devices to behaviors: by template id first, then by category, else `fallback`.
/// Empty in the MVP, so every device resolves to `DefaultDeviceBehavior`.
public struct DeviceBehaviorRegistry {
    private var byTemplateID: [String: any DeviceBehavior] = [:]
    private var byCategory: [DeviceCategory: any DeviceBehavior] = [:]

    /// Used when nothing more specific is registered.
    public var fallback: any DeviceBehavior = DefaultDeviceBehavior()

    public init() {}

    public mutating func register(_ behavior: any DeviceBehavior, forCategory category: DeviceCategory) {
        byCategory[category] = behavior
    }

    public mutating func register(_ behavior: any DeviceBehavior, forTemplateID templateID: String) {
        byTemplateID[templateID] = behavior
    }

    public mutating func unregister(category: DeviceCategory) {
        byCategory[category] = nil
    }

    public mutating func unregister(templateID: String) {
        byTemplateID[templateID] = nil
    }

    /// The behavior responsible for the device.
    public func behavior(for device: Device) -> any DeviceBehavior {
        byTemplateID[device.templateID] ?? byCategory[device.category] ?? fallback
    }
}
