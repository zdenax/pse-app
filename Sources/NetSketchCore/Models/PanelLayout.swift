import Foundation
#if canImport(CoreGraphics)
import CoreGraphics
#endif

/// How the ports of one panel section are placed.
public enum PortArrangement: String, Codable, CaseIterable, Hashable, Sendable {
    /// All ports left to right in one row (see `PanelSection.row`).
    case singleRow
    /// Two rows, column by column: 1st port top, 2nd bottom, 3rd top, ... (typical switch).
    case oddTopEvenBottom
    /// Two rows, column by column: 1st port bottom, 2nd top, 3rd bottom, ...
    case evenTopOddBottom
    /// Two rows, row by row: first half on the top row, second half on the bottom row.
    case topRowThenBottomRow

    public var usesTwoRows: Bool { self != .singleRow }
}

/// One left-to-right block of the front panel.
///
/// JSON keys: `groups` (or a single `group`), `arrangement` (default "singleRow"),
/// `row`, `blockColumns`, `label`, `placeholderWidth` (all optional).
public struct PanelSection: Codable, Equatable, Hashable, Sendable {
    /// Indices into `DeviceTemplate.portGroups` (matched against `Port.groupIndex`).
    /// The ports of all listed groups are concatenated in this order and then arranged.
    public var groups: [Int]
    public var arrangement: PortArrangement
    /// Row used by `.singleRow` (0 = top). `nil` means the bottom row.
    public var row: Int?
    /// Insert a small visual gap after every N columns (e.g. 6 = blocks of 12 ports in two rows).
    public var blockColumns: Int?
    /// Optional caption, e.g. "PoE+", "Uplink", "NIM".
    public var label: String?
    /// Width in cells reserved when the section has no ports (an empty module bay).
    public var placeholderWidth: CGFloat?

    public init(
        groups: [Int],
        arrangement: PortArrangement = .singleRow,
        row: Int? = nil,
        blockColumns: Int? = nil,
        label: String? = nil,
        placeholderWidth: CGFloat? = nil
    ) {
        self.groups = groups
        self.arrangement = arrangement
        self.row = row
        self.blockColumns = blockColumns
        self.label = label
        self.placeholderWidth = placeholderWidth
    }

    private enum CodingKeys: String, CodingKey {
        case groups, group, arrangement, row, blockColumns, label, placeholderWidth
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        if let list = try c.decodeIfPresent([Int].self, forKey: .groups) {
            groups = list
        } else if let single = try c.decodeIfPresent(Int.self, forKey: .group) {
            groups = [single]
        } else {
            groups = []
        }
        arrangement = try c.decodeIfPresent(PortArrangement.self, forKey: .arrangement) ?? .singleRow
        row = try c.decodeIfPresent(Int.self, forKey: .row)
        blockColumns = try c.decodeIfPresent(Int.self, forKey: .blockColumns)
        label = try c.decodeIfPresent(String.self, forKey: .label)
        placeholderWidth = try c.decodeIfPresent(CGFloat.self, forKey: .placeholderWidth)
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(groups, forKey: .groups)
        try c.encode(arrangement, forKey: .arrangement)
        try c.encodeIfPresent(row, forKey: .row)
        try c.encodeIfPresent(blockColumns, forKey: .blockColumns)
        try c.encodeIfPresent(label, forKey: .label)
        try c.encodeIfPresent(placeholderWidth, forKey: .placeholderWidth)
    }
}

/// Front-panel description: a rectangle `rows` port-rows tall, filled left to right by `sections`.
///
/// The layout itself holds no ports. Call `grid(for:)` (or `Device.panelGrid`) to get the
/// position of every port in cell units, then multiply by your cell size.
public struct PanelLayout: Codable, Equatable, Hashable, Sendable {
    /// Number of port rows on the panel (1 or 2 for everything in the built-in catalog).
    public var rows: Int
    /// Blocks of ports, left to right.
    public var sections: [PanelSection]

    /// Default horizontal gap between two sections, in cells.
    public static let sectionGap: CGFloat = 0.5
    /// Default extra gap between port blocks inside a section, in cells.
    public static let blockGap: CGFloat = 0.25
    /// Default width of an empty module bay, in cells.
    public static let defaultPlaceholderWidth: CGFloat = 4

    public init(rows: Int = 1, sections: [PanelSection] = []) {
        self.rows = max(1, rows)
        self.sections = sections
    }

    private enum CodingKeys: String, CodingKey { case rows, sections }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        rows = max(1, try c.decodeIfPresent(Int.self, forKey: .rows) ?? 1)
        sections = try c.decodeIfPresent([PanelSection].self, forKey: .sections) ?? []
    }

    /// A reasonable layout derived from the port groups alone: one section per group,
    /// two rows (odd on top) for copper/cage groups of 12 or more ports, otherwise a single row.
    public static func automatic(for groups: [PortGroup]) -> PanelLayout {
        var sections: [PanelSection] = []
        for (index, group) in groups.enumerated() {
            sections.append(automaticSection(index: index, group: group))
        }
        let rows = sections.contains { $0.arrangement.usesTwoRows } ? 2 : 1
        return PanelLayout(rows: rows, sections: sections)
    }

    private static func automaticSection(index: Int, group: PortGroup) -> PanelSection {
        let count = group.portCount
        let dense = count >= 12 && (group.connector == .rj45 || group.connector.isModular)
        return PanelSection(
            groups: [index],
            arrangement: dense ? .oddTopEvenBottom : .singleRow,
            blockColumns: dense && count >= 24 ? 6 : nil,
            label: group.label,
            placeholderWidth: group.isPlaceholder ? defaultPlaceholderWidth : nil
        )
    }

    /// The layout made consistent with `groups`: unknown or repeated group indices are dropped,
    /// groups no section mentions are appended with an automatic section (so every port is
    /// always drawn), missing captions are taken from the group label, placeholder groups get
    /// a width, and `rows` is raised to 2 when a two-row arrangement is used. Idempotent.
    public func normalized(for groups: [PortGroup]) -> PanelLayout {
        var seen = Set<Int>()
        var result: [PanelSection] = []
        for var section in sections {
            section.groups = section.groups.filter { groups.indices.contains($0) && seen.insert($0).inserted }
            guard !section.groups.isEmpty else { continue }
            if section.label == nil, section.groups.count == 1 {
                section.label = groups[section.groups[0]].label
            }
            if let columns = section.blockColumns, columns <= 0 {
                section.blockColumns = nil
            }
            if section.placeholderWidth == nil, section.groups.allSatisfy({ groups[$0].isPlaceholder }) {
                section.placeholderWidth = PanelLayout.defaultPlaceholderWidth
            }
            result.append(section)
        }
        for (index, group) in groups.enumerated() where !seen.contains(index) {
            result.append(PanelLayout.automaticSection(index: index, group: group))
        }
        let needed = result.contains { $0.arrangement.usesTwoRows } ? 2 : 1
        return PanelLayout(rows: max(rows, needed), sections: result)
    }

    /// Positions of all ports in cell units.
    ///
    /// - Parameter groupIndices: for every port (in device order) the index of its port group.
    /// Ports whose group no section mentions are appended in a trailing single-row section,
    /// so the grid always contains exactly one slot per port.
    public func grid(
        groupIndices: [Int],
        sectionGap: CGFloat = PanelLayout.sectionGap,
        blockGap: CGFloat = PanelLayout.blockGap
    ) -> PanelGrid {
        var portsByGroup: [Int: [Int]] = [:]
        for (portIndex, group) in groupIndices.enumerated() {
            portsByGroup[group, default: []].append(portIndex)
        }

        // Tolerate layouts that were never normalized: a two-row arrangement implies two rows.
        let rows = max(1, self.rows, sections.contains { $0.arrangement.usesTwoRows } ? 2 : 1)
        var slots: [PanelGrid.Slot] = []
        var frames: [PanelGrid.SectionFrame] = []
        var cursor: CGFloat = 0
        var maxRow = 0
        var consumed = Set<Int>()

        func place(_ section: PanelSection) {
            let groups = section.groups.filter { consumed.insert($0).inserted }
            let ports = groups.flatMap { portsByGroup[$0] ?? [] }
            let frameIndex = frames.count

            if ports.isEmpty {
                guard let width = section.placeholderWidth, width > 0 else { return }
                frames.append(.init(groups: groups, x: cursor, width: width, label: section.label, isPlaceholder: true))
                cursor += width + sectionGap
                return
            }

            let block = section.blockColumns.flatMap { $0 > 0 ? $0 : nil }
            func offset(_ column: Int) -> CGFloat {
                CGFloat(column) + (block.map { blockGap * CGFloat(column / $0) } ?? 0)
            }

            var lastColumn = 0
            let perRow = (ports.count + 1) / 2
            for (i, portIndex) in ports.enumerated() {
                let column: Int
                let row: Int
                switch section.arrangement {
                case .singleRow:
                    column = i
                    row = min(max(0, section.row ?? (rows - 1)), rows - 1)
                case .oddTopEvenBottom:
                    column = i / 2
                    row = i % 2
                case .evenTopOddBottom:
                    column = i / 2
                    row = 1 - i % 2
                case .topRowThenBottomRow:
                    column = i < perRow ? i : i - perRow
                    row = i < perRow ? 0 : 1
                }
                lastColumn = max(lastColumn, column)
                maxRow = max(maxRow, row)
                slots.append(.init(portIndex: portIndex, section: frameIndex, column: column, row: row, x: cursor + offset(column)))
            }

            let width = offset(lastColumn) + 1
            frames.append(.init(groups: groups, x: cursor, width: width, label: section.label, isPlaceholder: false))
            cursor += width + sectionGap
        }

        for section in sections { place(section) }
        for group in portsByGroup.keys.sorted() where !consumed.contains(group) {
            place(PanelSection(groups: [group]))
        }

        return PanelGrid(
            rows: max(rows, maxRow + 1),
            width: frames.isEmpty ? 0 : cursor - sectionGap,
            slots: slots.sorted { $0.portIndex < $1.portIndex },
            sections: frames
        )
    }

    /// Positions of `ports` in cell units (uses each port's `groupIndex`).
    public func grid(for ports: [Port]) -> PanelGrid {
        grid(groupIndices: ports.map(\.groupIndex))
    }
}

/// A resolved front panel in cell units: one port cell is 1 wide and 1 tall,
/// the origin is the panel's top-left corner, x grows right and rows grow down.
public struct PanelGrid: Equatable, Sendable {
    /// Position of one port.
    public struct Slot: Equatable, Hashable, Sendable {
        /// Index into the device's (or template's) port array.
        public let portIndex: Int
        /// Index into `PanelGrid.sections`.
        public let section: Int
        /// Column inside the section (0-based, without gaps).
        public let column: Int
        /// Row on the panel, 0 = top.
        public let row: Int
        /// Left edge of the cell in cell units, gaps included. The cell centre is (x + 0.5, row + 0.5).
        public let x: CGFloat

        public init(portIndex: Int, section: Int, column: Int, row: Int, x: CGFloat) {
            self.portIndex = portIndex
            self.section = section
            self.column = column
            self.row = row
            self.x = x
        }
    }

    /// Horizontal extent of one section, for captions, separators and empty bays.
    public struct SectionFrame: Equatable, Hashable, Sendable {
        /// Port-group indices drawn in this section.
        public let groups: [Int]
        public let x: CGFloat
        public let width: CGFloat
        public let label: String?
        /// True for an empty module bay (no slots; draw a blank plate with the label).
        public let isPlaceholder: Bool

        public init(groups: [Int], x: CGFloat, width: CGFloat, label: String?, isPlaceholder: Bool) {
            self.groups = groups
            self.x = x
            self.width = width
            self.label = label
            self.isPlaceholder = isPlaceholder
        }
    }

    /// Number of port rows.
    public let rows: Int
    /// Total width in cells, gaps included.
    public let width: CGFloat
    /// One slot per port, ordered by `portIndex`.
    public let slots: [Slot]
    /// Sections left to right.
    public let sections: [SectionFrame]

    public init(rows: Int, width: CGFloat, slots: [Slot], sections: [SectionFrame]) {
        self.rows = rows
        self.width = width
        self.slots = slots
        self.sections = sections
    }

    /// The slot of the port at `index`, if it exists.
    public func slot(forPortIndex index: Int) -> Slot? {
        if slots.indices.contains(index), slots[index].portIndex == index { return slots[index] }
        return slots.first { $0.portIndex == index }
    }
}
