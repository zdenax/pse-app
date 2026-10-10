import Foundation

/// Prefix of the string payload the palette drags onto the canvas.
/// The full payload is `"netsketch-template:<templateID>"`.
public let templateDragPrefix = "netsketch-template:"

/// Extracts the template identifier from a dragged payload, if it is one of ours.
func templateID(fromDragPayload payload: String) -> String? {
    guard payload.hasPrefix(templateDragPrefix) else { return nil }
    let id = String(payload.dropFirst(templateDragPrefix.count))
    return id.isEmpty ? nil : id
}
