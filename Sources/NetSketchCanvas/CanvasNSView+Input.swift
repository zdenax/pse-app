import AppKit
import NetSketchCore

// MARK: - Gesture scheme
//
//  click                      select device / cable / note; click a free port to start or finish a cable
//  Shift- or Cmd-click        toggle in the selection
//  drag an object             move the whole selection (one undo step)
//  drag on empty canvas       rubber-band selection (Shift / Cmd adds to the selection)
//  scroll (two fingers/wheel) pan
//  Cmd-scroll, pinch          zoom around the pointer
//  Space-drag, Option-drag on empty canvas, middle-button drag   pan
//  double-click               rename device / edit note / rename bundle; on empty canvas: new note
//  Esc                        cancel drag, cabling or selection;   Delete: remove the selection
//  arrow keys                 nudge the selection by one grid step

extension CanvasNSView {

    // MARK: Pointer logic (independent of NSEvent)

    func pointerDown(at viewPoint: CGPoint, clickCount: Int, extending: Bool, panModifier: Bool) {
        finishEditing(commit: true, restoreFocus: true)
        pointerView = viewPoint
        let canvas = canvasPoint(viewPoint)
        let hit = self.hit(atView: viewPoint)

        if isSpaceDown || (panModifier && hit == .empty) {
            interaction = .panning(lastView: viewPoint)
            NSCursor.closedHand.set()
            return
        }
        if clickCount >= 2, handleDoubleClick(hit, at: canvas) {
            interaction = .idle
            return
        }

        var collapseTo: SelectionItem?
        switch hit {
        case .deviceHeader(let id), .devicePanel(let id), .warning(let id):
            collapseTo = pressSelect(.device(id), extending: extending)
        case .annotation(let id):
            collapseTo = pressSelect(.annotation(id), extending: extending)
        case .link(let ids), .bundleLabel(_, let ids):
            selectLinks(ids, extending: extending)
        case .port, .statusDot, .empty:
            break
        }
        interaction = .pressed(hit: hit, startView: viewPoint, startCanvas: canvas,
                               extending: extending, collapseTo: collapseTo)
        needsDisplay = true
    }

    func pointerDragged(to viewPoint: CGPoint) {
        pointerView = viewPoint
        let canvas = canvasPoint(viewPoint)
        switch interaction {
        case .idle:
            return
        case .pressed(let hit, let startView, let startCanvas, let extending, _):
            guard hypot(viewPoint.x - startView.x, viewPoint.y - startView.y) >= CanvasNSView.dragThreshold else { return }
            if let item = draggableItem(for: hit) {
                if !store.selection.contains(item) {
                    if case .port = hit {
                        store.select(item, extending: extending)
                    } else if extending {
                        // The press just toggled it off: nothing to drag.
                        interaction = .idle
                        return
                    } else {
                        store.select(item)
                    }
                }
                store.beginDrag()
                interaction = .draggingItems(startCanvas: startCanvas)
                NSCursor.closedHand.set()
                store.dragSelection(translation: CGSize(width: canvas.x - startCanvas.x, height: canvas.y - startCanvas.y))
            } else {
                interaction = .rubberBand(startCanvas: startCanvas, currentCanvas: canvas,
                                          base: extending ? store.selection : [])
                applyRubberBand()
            }
        case .draggingItems(let startCanvas):
            store.dragSelection(translation: CGSize(width: canvas.x - startCanvas.x, height: canvas.y - startCanvas.y))
        case .rubberBand(let startCanvas, _, let base):
            interaction = .rubberBand(startCanvas: startCanvas, currentCanvas: canvas, base: base)
            applyRubberBand()
        case .panning(let lastView):
            viewport.pan(by: CGSize(width: viewPoint.x - lastView.x, height: viewPoint.y - lastView.y))
            interaction = .panning(lastView: viewPoint)
        }
        needsDisplay = true
    }

    func pointerUp(at viewPoint: CGPoint) {
        let finished = interaction
        interaction = .idle
        switch finished {
        case .pressed(let hit, _, _, let extending, let collapseTo):
            switch hit {
            case .port(let ref):
                clickPort(ref)
            case .statusDot(let linkID, let end):
                perform { _ = try store.cycleStatus(linkID: linkID, end: end) }
            case .empty:
                if store.pendingPort != nil { store.cancelPendingPort() }
                if !extending, !store.selection.isEmpty { store.clearSelection() }
            default:
                // A plain click on one of several selected objects narrows the selection to it.
                if let collapseTo { store.select(collapseTo) }
            }
        case .draggingItems:
            store.endDrag()
        case .rubberBand, .panning, .idle:
            break
        }
        pointerMoved(to: viewPoint)
        needsDisplay = true
    }

    /// Pointer moved without a button; `nil` = left the view.
    func pointerMoved(to viewPoint: CGPoint?) {
        pointerView = viewPoint
        guard let viewPoint else {
            setHover(.empty)
            return
        }
        if case .idle = interaction {
            setHover(hit(atView: viewPoint))
        }
        if store.pendingPort != nil || dropGhost != nil { needsDisplay = true }
    }

    private func setHover(_ newValue: CanvasHit) {
        guard newValue != hover else {
            updateCursor()
            return
        }
        hover = newValue
        hoverSince = ProcessInfo.processInfo.systemUptime
        needsDisplay = true
        updateCursor()
        switch newValue {
        case .statusDot, .link, .bundleLabel:
            // Delayed tooltip: repaint once the delay has passed (if still hovering the same thing).
            DispatchQueue.main.asyncAfter(deadline: .now() + CanvasNSView.tooltipDelay + 0.03) { [weak self] in
                guard let self, self.hover == newValue else { return }
                self.needsDisplay = true
            }
        default:
            break
        }
    }

    /// True when a cable cannot be plugged into `ref` right now.
    func isPortBlocked(_ ref: PortRef) -> Bool {
        if currentScene().usedPorts.contains(ref) { return true }
        if let pending = store.pendingPort, pending != ref, pending.deviceID == ref.deviceID { return true }
        return false
    }

    func updateCursor() {
        if case .panning = interaction { NSCursor.closedHand.set(); return }
        if case .draggingItems = interaction { NSCursor.closedHand.set(); return }
        if isSpaceDown { NSCursor.openHand.set(); return }
        switch hover {
        case .port(let ref):
            (isPortBlocked(ref) ? NSCursor.operationNotAllowed : NSCursor.pointingHand).set()
        case .statusDot:
            NSCursor.pointingHand.set()
        case .empty where store.pendingPort != nil:
            NSCursor.crosshair.set()
        default:
            NSCursor.arrow.set()
        }
    }

    // MARK: Selection helpers

    /// Selects on mouse down. Returns the item the selection should collapse to on a plain mouse up.
    private func pressSelect(_ item: SelectionItem, extending: Bool) -> SelectionItem? {
        if extending {
            store.select(item, extending: true)
            return nil
        }
        if store.selection.contains(item) {
            return store.selection.count > 1 ? item : nil
        }
        store.select(item)
        return nil
    }

    private func selectLinks(_ ids: [UUID], extending: Bool) {
        let items = Set(ids.map(SelectionItem.link))
        guard !items.isEmpty else { return }
        if extending {
            if items.isSubset(of: store.selection) {
                store.selection.subtract(items)
            } else {
                store.selection.formUnion(items)
            }
        } else if store.selection != items {
            store.selection = items
        }
    }

    private func draggableItem(for hit: CanvasHit) -> SelectionItem? {
        switch hit {
        case .deviceHeader(let id), .devicePanel(let id), .warning(let id):
            return .device(id)
        case .port(let ref):
            return .device(ref.deviceID)
        case .annotation(let id):
            return .annotation(id)
        default:
            return nil
        }
    }

    private func applyRubberBand() {
        guard case .rubberBand(let start, let current, let base) = interaction else { return }
        let rect = CGRect(x: min(start.x, current.x), y: min(start.y, current.y),
                          width: abs(start.x - current.x), height: abs(start.y - current.y))
        let caught = currentScene().elements(in: rect)
        var selection = base
        caught.devices.forEach { selection.insert(.device($0)) }
        caught.links.forEach { selection.insert(.link($0)) }
        caught.annotations.forEach { selection.insert(.annotation($0)) }
        if selection != store.selection { store.selection = selection }
    }

    // MARK: Cabling

    func clickPort(_ ref: PortRef) {
        do {
            let result = try store.clickPort(ref)
            feedback.clear()
            if case .connected(let link) = result {
                store.select(.link(link.id))
            }
        } catch let error as EditError {
            let wasIdle = store.pendingPort == nil
            report(error)
            flashRejected(ref)
            // Clicking an occupied port outside of cabling shows what occupies it.
            if wasIdle, case .portInUse(let used) = error, let link = store.link(at: used) {
                store.select(.link(link.id))
            }
        } catch {
            feedback.show("Operaci nelze provést.")
        }
    }

    private func flashRejected(_ ref: PortRef) {
        rejectedPort = ref
        rejectedGeneration += 1
        let generation = rejectedGeneration
        needsDisplay = true
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.8) { [weak self] in
            guard let self, self.rejectedGeneration == generation else { return }
            self.rejectedPort = nil
            self.needsDisplay = true
        }
    }

    func report(_ error: EditError) {
        feedback.show(CanvasStrings.message(for: error, in: store.project))
    }

    /// Runs a store operation and shows a refusal in the banner.
    func perform(_ body: () throws -> Void) {
        do {
            try body()
        } catch let error as EditError {
            report(error)
        } catch {
            feedback.show("Operaci nelze provést.")
        }
    }

    // MARK: Double click

    private func handleDoubleClick(_ hit: CanvasHit, at canvas: CGPoint) -> Bool {
        switch hit {
        case .deviceHeader(let id), .devicePanel(let id), .warning(let id):
            store.select(.device(id))
            beginEditing(.hostname(id))
            return true
        case .annotation(let id):
            store.select(.annotation(id))
            beginEditing(.annotation(id))
            return true
        case .bundleLabel(let id, _):
            beginEditing(.bundleLabel(id))
            return true
        case .empty:
            guard store.pendingPort == nil else { return false }
            beginEditing(.newAnnotation(canvas))
            return true
        case .port, .statusDot, .link:
            return false
        }
    }

    // MARK: NSEvent plumbing

    private func viewPoint(_ event: NSEvent) -> CGPoint {
        convert(event.locationInWindow, from: nil)
    }

    override func mouseDown(with event: NSEvent) {
        let flags = event.modifierFlags
        if flags.contains(.control) {
            // Control-click is the secondary click.
            finishEditing(commit: true, restoreFocus: true)
            window?.makeFirstResponder(self)
            if let menu = menu(for: event) {
                NSMenu.popUpContextMenu(menu, with: event, for: self)
            }
            return
        }
        // Commit a running inline edit before focus moves, then take the keyboard.
        finishEditing(commit: true, restoreFocus: false)
        window?.makeFirstResponder(self)
        pointerDown(at: viewPoint(event), clickCount: event.clickCount,
                    extending: flags.contains(.shift) || flags.contains(.command),
                    panModifier: flags.contains(.option))
    }

    override func mouseDragged(with event: NSEvent) {
        pointerDragged(to: viewPoint(event))
    }

    override func mouseUp(with event: NSEvent) {
        pointerUp(at: viewPoint(event))
    }

    override func mouseMoved(with event: NSEvent) {
        pointerMoved(to: viewPoint(event))
    }

    override func mouseEntered(with event: NSEvent) {
        pointerMoved(to: viewPoint(event))
    }

    override func mouseExited(with event: NSEvent) {
        pointerMoved(to: nil)
    }

    override func otherMouseDown(with event: NSEvent) {
        // Middle button pans.
        finishEditing(commit: true, restoreFocus: true)
        interaction = .panning(lastView: viewPoint(event))
        NSCursor.closedHand.set()
    }

    override func otherMouseDragged(with event: NSEvent) {
        pointerDragged(to: viewPoint(event))
    }

    override func otherMouseUp(with event: NSEvent) {
        interaction = .idle
        pointerMoved(to: viewPoint(event))
    }

    override func scrollWheel(with event: NSEvent) {
        finishEditing(commit: true, restoreFocus: true)
        let point = viewPoint(event)
        let precise = event.hasPreciseScrollingDeltas
        if event.modifierFlags.contains(.command) {
            // Cmd-scroll zooms around the pointer.
            let delta = event.scrollingDeltaY
            guard delta != 0 else { return }
            viewport.zoom(by: exp(delta * (precise ? 0.01 : 0.12)), anchor: point)
        } else {
            let factor: CGFloat = precise ? 1 : 14
            viewport.pan(by: CGSize(width: event.scrollingDeltaX * factor, height: event.scrollingDeltaY * factor))
        }
        refreshAfterViewportChange(pointer: point)
    }

    override func magnify(with event: NSEvent) {
        finishEditing(commit: true, restoreFocus: true)
        let point = viewPoint(event)
        viewport.zoom(by: 1 + event.magnification, anchor: point)
        refreshAfterViewportChange(pointer: point)
    }

    override func smartMagnify(with event: NSEvent) {
        finishEditing(commit: true, restoreFocus: true)
        if abs(viewport.clampedZoom - 1) < 0.01 {
            viewport.fit()
        } else {
            viewport.setZoom(1, anchor: viewPoint(event))
        }
        refreshAfterViewportChange(pointer: viewPoint(event))
    }

    private func refreshAfterViewportChange(pointer: CGPoint) {
        // The content moved under a resting pointer.
        if case .idle = interaction { pointerMoved(to: pointer) }
        needsDisplay = true
    }

    // MARK: Keyboard

    override func keyDown(with event: NSEvent) {
        let flags = event.modifierFlags.intersection(.deviceIndependentFlagsMask)
        if flags.contains(.command) || flags.contains(.control) {
            super.keyDown(with: event)
            return
        }
        switch event.keyCode {
        case 53: // Esc
            cancelCurrentOperation()
        case 51, 117: // Backspace, forward delete
            deleteSelection()
        case 49: // Space: hold to pan
            if !event.isARepeat {
                isSpaceDown = true
                updateCursor()
            }
        case 123: nudge(dx: -1, dy: 0)
        case 124: nudge(dx: 1, dy: 0)
        case 125: nudge(dx: 0, dy: 1)
        case 126: nudge(dx: 0, dy: -1)
        case 36, 76: // Return, Enter: edit the single selected object
            if store.selection.count == 1, let item = store.selection.first {
                switch item {
                case .device(let id): beginEditing(.hostname(id))
                case .annotation(let id): beginEditing(.annotation(id))
                case .link: super.keyDown(with: event)
                }
            } else {
                super.keyDown(with: event)
            }
        default:
            super.keyDown(with: event)
        }
    }

    override func keyUp(with event: NSEvent) {
        if event.keyCode == 49 {
            isSpaceDown = false
            updateCursor()
        } else {
            super.keyUp(with: event)
        }
    }

    override func resignFirstResponder() -> Bool {
        isSpaceDown = false
        return super.resignFirstResponder()
    }

    override func cancelOperation(_ sender: Any?) {
        cancelCurrentOperation()
    }

    /// Esc: abort whatever is in progress, innermost first.
    func cancelCurrentOperation() {
        switch interaction {
        case .draggingItems:
            store.cancelDrag()
            interaction = .idle
        case .rubberBand(_, _, let base):
            store.selection = base
            interaction = .idle
        case .panning, .pressed:
            interaction = .idle
        case .idle:
            if store.pendingPort != nil {
                store.cancelPendingPort()
            } else if !store.selection.isEmpty {
                store.clearSelection()
            }
        }
        feedback.clear()
        updateCursor()
        needsDisplay = true
    }

    func deleteSelection() {
        guard !store.selection.isEmpty else { return }
        if case .draggingItems = interaction {
            store.cancelDrag()
            interaction = .idle
        }
        store.removeSelection()
    }

    private func nudge(dx: CGFloat, dy: CGFloat) {
        guard !store.selection.isEmpty else { return }
        let step = store.snapToGrid && store.gridSize > 0 ? store.gridSize : 1
        store.moveSelection(by: CGSize(width: dx * step, height: dy * step))
    }

    // MARK: Responder-chain actions (Edit menu)

    /// Edit > Delete while the canvas has focus.
    @objc func delete(_ sender: Any?) {
        deleteSelection()
    }

    override func selectAll(_ sender: Any?) {
        store.selectAll()
    }

    // MARK: Context menu

    override func menu(for event: NSEvent) -> NSMenu? {
        finishEditing(commit: true, restoreFocus: true)
        let point = viewPoint(event)
        let canvas = canvasPoint(point)
        let hit = self.hit(atView: point)
        let menu = NSMenu()
        menu.autoenablesItems = false
        let project = store.project

        switch hit {
        case .deviceHeader, .devicePanel, .warning, .port:
            guard let id = hit.deviceID else { return nil }
            if !store.selection.contains(.device(id)) { store.select(.device(id)) }
            menu.addItem(ClosureMenuItem(CanvasStrings.menuRename) { [weak self] in
                self?.beginEditing(.hostname(id))
            })
            menu.addItem(.separator())
            menu.addItem(ClosureMenuItem(CanvasStrings.menuDelete) { [weak self] in
                self?.deleteSelection()
            })

        case .annotation(let id):
            if !store.selection.contains(.annotation(id)) { store.select(.annotation(id)) }
            menu.addItem(ClosureMenuItem(CanvasStrings.menuEditText) { [weak self] in
                self?.beginEditing(.annotation(id))
            })
            menu.addItem(.separator())
            menu.addItem(ClosureMenuItem(CanvasStrings.menuDelete) { [weak self] in
                self?.deleteSelection()
            })

        case .link, .bundleLabel, .statusDot:
            let ids: [UUID]
            switch hit {
            case .link(let hitIDs): ids = hitIDs
            case .bundleLabel(_, let hitIDs): ids = hitIDs
            case .statusDot(let linkID, _): ids = [linkID]
            default: ids = []
            }
            let items = Set(ids.map(SelectionItem.link))
            if !items.isSubset(of: store.selection) { store.selection = items }
            let selectedLinks = project.links.filter { store.selection.contains(.link($0.id)) }
            guard let first = selectedLinks.first else { return nil }

            let cableMenu = NSMenu()
            cableMenu.autoenablesItems = false
            for type in CableType.allCases {
                let checked = selectedLinks.allSatisfy { $0.cableType == type }
                cableMenu.addItem(ClosureMenuItem(CanvasStrings.cableName(type), checked: checked) { [weak self] in
                    guard let self else { return }
                    self.store.beginUndoGroup()
                    for link in selectedLinks {
                        self.perform { try self.store.setCableType(linkID: link.id, type) }
                    }
                    self.store.endUndoGroup()
                })
            }
            let cableItem = NSMenuItem(title: CanvasStrings.menuCableType, action: nil, keyEquivalent: "")
            cableItem.submenu = cableMenu
            menu.addItem(cableItem)

            if selectedLinks.count == 1 {
                for end in LinkEnd.allCases {
                    let statusMenu = NSMenu()
                    statusMenu.autoenablesItems = false
                    for status in LinkStatus.allCases {
                        let title = CanvasStrings.statusName(status).prefix(1).uppercased()
                            + CanvasStrings.statusName(status).dropFirst()
                        statusMenu.addItem(ClosureMenuItem(title, checked: first.status(end) == status) { [weak self] in
                            guard let self else { return }
                            self.perform { try self.store.setStatus(linkID: first.id, end: end, status: status) }
                        })
                    }
                    let title = (end == .a ? CanvasStrings.menuStatusA : CanvasStrings.menuStatusB)
                        + " (\(CanvasStrings.portTitle(first.ref(end), in: project)))"
                    let item = NSMenuItem(title: title, action: nil, keyEquivalent: "")
                    item.submenu = statusMenu
                    menu.addItem(item)
                }
            }

            menu.addItem(.separator())
            let bundleIDs = Set(selectedLinks.compactMap(\.bundleID))
            if bundleIDs.isEmpty {
                let parallel = Set(selectedLinks.map(\.devicePair)).count == 1
                menu.addItem(ClosureMenuItem(CanvasStrings.menuBundle, enabled: selectedLinks.count >= 2 && parallel) { [weak self] in
                    guard let self else { return }
                    self.perform { _ = try self.store.createBundle(linkIDs: selectedLinks.map(\.id)) }
                })
            } else if bundleIDs.count == 1, let bundleID = bundleIDs.first {
                menu.addItem(ClosureMenuItem(CanvasStrings.menuRenameBundle) { [weak self] in
                    self?.beginEditing(.bundleLabel(bundleID))
                })
                menu.addItem(ClosureMenuItem(CanvasStrings.menuUnbundle) { [weak self] in
                    guard let self else { return }
                    self.perform { try self.store.unbundle(id: bundleID) }
                })
            }
            menu.addItem(.separator())
            menu.addItem(ClosureMenuItem(CanvasStrings.menuDeleteCable) { [weak self] in
                self?.deleteSelection()
            })

        case .empty:
            menu.addItem(ClosureMenuItem(CanvasStrings.menuAddAnnotation) { [weak self] in
                self?.beginEditing(.newAnnotation(canvas))
            })
            menu.addItem(ClosureMenuItem(CanvasStrings.menuSelectAll,
                                         enabled: !(project.devices.isEmpty && project.annotations.isEmpty)) { [weak self] in
                self?.store.selectAll()
            })
            menu.addItem(.separator())
            menu.addItem(ClosureMenuItem(CanvasStrings.menuZoomToFit) { [weak self] in
                self?.viewport.fit()
            })
            menu.addItem(ClosureMenuItem(CanvasStrings.menuActualSize) { [weak self] in
                self?.viewport.reset()
            })
        }
        return menu
    }

    // MARK: Inline editing

    func beginEditing(_ target: EditTarget) {
        finishEditing(commit: true, restoreFocus: false)
        let scene = currentScene()
        let zoom = viewport.clampedZoom
        let palette = Palette.resolve(dark: effectiveAppearance.isDarkAppearance)

        var canvasRect: CGRect
        var text = ""
        var style = TextStyle.annotation
        var alignment = NSTextAlignment.left
        var multiline = false
        var placeholder: String?

        switch target {
        case .hostname(let id):
            guard let node = scene.node(for: id) else { return }
            canvasRect = node.hostnameEditRect
            text = node.hostname
            style = .hostname
            alignment = node.centeredLabels ? .center : .left
        case .annotation(let id):
            guard let annotation = scene.annotations.first(where: { $0.id == id }) else { return }
            canvasRect = annotation.frame.insetBy(dx: -2, dy: -2)
            canvasRect.size.width = max(canvasRect.width + 40, 200)
            text = annotation.text
            multiline = true
        case .newAnnotation(let point):
            let lineHeight = TextRenderer.shared.lineHeight(style: .annotation)
            canvasRect = CGRect(x: point.x - AnnotationGeometry.paddingX, y: point.y - AnnotationGeometry.paddingY,
                                width: 220, height: lineHeight + 2 * AnnotationGeometry.paddingY)
            multiline = true
            placeholder = CanvasStrings.newAnnotationPlaceholder
        case .bundleLabel(let id):
            guard let bundle = scene.bundles.first(where: { $0.id == id }) else { return }
            canvasRect = bundle.labelRect.insetBy(dx: -24, dy: -3)
            text = bundle.label
            style = .bundle
            alignment = .center
        }

        let fontSize = min(max(style.size * zoom, 11), 32)
        var frame = viewport.viewRect(fromCanvas: canvasRect)
        let lineCount = CGFloat(max(text.split(separator: "\n", omittingEmptySubsequences: false).count, 1))
        frame.size.width = max(frame.width, 150)
        frame.size.height = max(frame.height, lineCount * ceil(fontSize * 1.28) + 8)
        if alignment == .center {
            // Keep the field centered on what it edits.
            let center = viewport.viewPoint(fromCanvas: canvasRect.center)
            frame.origin.x = center.x - frame.width / 2
        }
        frame.origin.x = min(max(frame.minX, 4), max(bounds.width - frame.width - 4, 4))
        frame.origin.y = min(max(frame.minY, 4), max(bounds.height - frame.height - 4, 4))

        let field = NSTextField(frame: frame.integral)
        field.stringValue = text
        field.placeholderString = placeholder
        field.font = NSFont.systemFont(ofSize: fontSize, weight: style.weight.nsWeight)
        field.alignment = alignment
        field.isBordered = false
        field.isBezeled = false
        field.drawsBackground = true
        field.backgroundColor = palette.panelFill.nsColor
        field.textColor = palette.ink.nsColor
        field.focusRingType = .none
        field.usesSingleLineMode = !multiline
        field.cell?.wraps = multiline
        field.cell?.isScrollable = !multiline
        field.lineBreakMode = multiline ? .byWordWrapping : .byClipping
        field.maximumNumberOfLines = multiline ? 0 : 1
        field.wantsLayer = true
        field.layer?.cornerRadius = 4
        field.layer?.borderWidth = 1.5
        field.layer?.borderColor = palette.selection.cgColor
        field.delegate = self

        addSubview(field)
        editor = field
        editTarget = target
        window?.makeFirstResponder(field)
        field.currentEditor()?.selectAll(nil)
        needsDisplay = true
    }

    /// Ends inline editing. `restoreFocus` hands the keyboard back to the canvas; pass false when
    /// focus is already on its way somewhere else.
    func finishEditing(commit: Bool, restoreFocus: Bool = true) {
        guard let field = editor, let target = editTarget, !isFinishingEdit else { return }
        isFinishingEdit = true
        defer { isFinishingEdit = false }
        let text = field.stringValue
        editor = nil
        editTarget = nil
        field.delegate = nil
        let fieldHadFocus = field.currentEditor() != nil
        field.removeFromSuperview()
        if restoreFocus, fieldHadFocus {
            window?.makeFirstResponder(self)
        }
        if commit { applyEdit(target, text: text) }
        needsDisplay = true
    }

    private func applyEdit(_ target: EditTarget, text raw: String) {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        switch target {
        case .hostname(let id):
            let name = trimmed.replacingOccurrences(of: "\n", with: " ")
            // An emptied field keeps the old name.
            guard !name.isEmpty else { return }
            perform { try store.renameDevice(id: id, to: name) }
        case .annotation(let id):
            if trimmed.isEmpty {
                perform { try store.removeAnnotation(id: id) }
            } else {
                perform { try store.setAnnotationText(id: id, trimmed) }
            }
        case .newAnnotation(let point):
            guard !trimmed.isEmpty else { return }
            let annotation = store.addAnnotation(text: trimmed, at: point)
            store.select(.annotation(annotation.id))
        case .bundleLabel(let id):
            guard !trimmed.isEmpty else { return }
            perform { try store.renameBundle(id: id, to: trimmed.replacingOccurrences(of: "\n", with: " ")) }
        }
    }

    // NSTextFieldDelegate

    func control(_ control: NSControl, textView: NSTextView, doCommandBy commandSelector: Selector) -> Bool {
        if commandSelector == #selector(NSResponder.insertNewline(_:))
            || commandSelector == #selector(NSResponder.insertTab(_:)) {
            // Leave the field editor's own event handling before tearing the field down.
            DispatchQueue.main.async { [weak self] in self?.finishEditing(commit: true, restoreFocus: true) }
            return true
        }
        if commandSelector == #selector(NSResponder.cancelOperation(_:)) {
            DispatchQueue.main.async { [weak self] in self?.finishEditing(commit: false, restoreFocus: true) }
            return true
        }
        return false
    }

    func controlTextDidEndEditing(_ notification: Notification) {
        // Focus went elsewhere (another field, another view): keep what was typed.
        guard (notification.object as? NSTextField) === editor else { return }
        finishEditing(commit: true, restoreFocus: false)
    }

    // MARK: Drop target (palette -> canvas)

    static let dropTypes: [NSPasteboard.PasteboardType] = [
        .string,
        NSPasteboard.PasteboardType("public.utf8-plain-text"),
        NSPasteboard.PasteboardType("public.utf16-external-plain-text"),
        NSPasteboard.PasteboardType("public.plain-text"),
        NSPasteboard.PasteboardType("public.text"),
    ]

    /// Any string carried by a drag.
    static func string(from pasteboard: NSPasteboard) -> String? {
        if let string = pasteboard.string(forType: .string) { return string }
        for item in pasteboard.pasteboardItems ?? [] {
            for type in item.types {
                if let string = item.string(forType: type) { return string }
            }
        }
        if let strings = pasteboard.readObjects(forClasses: [NSString.self], options: nil) as? [String] {
            return strings.first
        }
        return nil
    }

    private func dropOperation(for sender: NSDraggingInfo) -> NSDragOperation {
        let mask = sender.draggingSourceOperationMask
        for candidate in [NSDragOperation.copy, .generic, .move, .link] where mask.contains(candidate) {
            return candidate
        }
        return []
    }

    private func updateDrop(_ sender: NSDraggingInfo) -> NSDragOperation {
        if dropTemplateID == nil, let string = CanvasNSView.string(from: sender.draggingPasteboard) {
            guard let id = templateID(fromDragPayload: string) else {
                // Some other text: not ours.
                clearDropGhost()
                return []
            }
            dropTemplateID = id
        }
        let point = canvasPoint(convert(sender.draggingLocation, from: nil))
        if let id = dropTemplateID, let template = store.catalog.template(id: id) {
            let preview = template.makeDevice(hostname: "", at: store.snap(point))
            dropGhost = NodeGeometry(device: preview, mode: store.viewMode)
        } else {
            dropGhost = nil
        }
        needsDisplay = true
        return dropOperation(for: sender)
    }

    func clearDropGhost() {
        dropTemplateID = nil
        if dropGhost != nil {
            dropGhost = nil
            needsDisplay = true
        }
    }

    override func draggingEntered(_ sender: NSDraggingInfo) -> NSDragOperation {
        updateDrop(sender)
    }

    override func draggingUpdated(_ sender: NSDraggingInfo) -> NSDragOperation {
        updateDrop(sender)
    }

    override func draggingExited(_ sender: NSDraggingInfo?) {
        clearDropGhost()
    }

    override func draggingEnded(_ sender: NSDraggingInfo) {
        clearDropGhost()
    }

    override func prepareForDragOperation(_ sender: NSDraggingInfo) -> Bool {
        true
    }

    override func performDragOperation(_ sender: NSDraggingInfo) -> Bool {
        defer { clearDropGhost() }
        guard let payload = CanvasNSView.string(from: sender.draggingPasteboard) else { return false }
        return handleDrop(payload: payload, atView: convert(sender.draggingLocation, from: nil))
    }

    /// Places the device described by a palette drag payload at a view location.
    @discardableResult
    func handleDrop(payload: String, atView viewPoint: CGPoint) -> Bool {
        guard let id = templateID(fromDragPayload: payload) else { return false }
        do {
            let device = try store.addDevice(templateID: id, at: canvasPoint(viewPoint))
            store.select(.device(device.id))
            feedback.clear()
            window?.makeFirstResponder(self)
            return true
        } catch let error as EditError {
            report(error)
            return false
        } catch {
            return false
        }
    }
}

/// A menu item that runs a closure.
final class ClosureMenuItem: NSMenuItem {
    private var handler: (() -> Void)?

    convenience init(_ title: String, enabled: Bool = true, checked: Bool = false, handler: @escaping () -> Void) {
        self.init(title: title, action: #selector(fire(_:)), keyEquivalent: "")
        self.handler = handler
        target = self
        isEnabled = enabled
        state = checked ? .on : .off
    }

    @objc private func fire(_ sender: Any?) {
        handler?()
    }
}
