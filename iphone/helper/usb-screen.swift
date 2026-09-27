// usb-screen: nimmt nur den Bildschirm des per USB verbundenen iPhones auf. Nie eine Kamera, nie Ton.
//
// Aufrufe:
//   usb-screen [--no-stdin] AUSGABE.mov SEKUNDEN   Aufnahme (1 bis 120 s)
//   usb-screen --access                            Kamerarecht dieses Prozesses pruefen/anfragen
//   usb-screen --version                           nur Startzeile (Test der App-Huelle)
//
// Ereignisse als JSON-Zeilen auf stdout:
//   launched {pid, version}, access_pending, access {status, granted}, started {pid, t},
//   finished {path, bytes, reason, t}, error {code, message}
// Stopp: "stop" auf stdin, SIGTERM oder SIGINT. Mit --no-stdin wird stdin ignoriert (losgeloeste Prozesse).
// Basis: iphone-mcp/usb-screen.swift (gemessen 56-60 fps, 26.09.2026). Neu: Zugriffspruefung vorab,
// --no-stdin, pid/Zeit in Ereignissen, Stoppgrund, Fehlercodes, bis 120 s.
import Foundation
import AVFoundation
import CoreMediaIO
import Darwin

let helperVersion = "1.0.0"

private func nowMs() -> Double { Date().timeIntervalSince1970 * 1000 }

private func emit(_ object: [String: Any]) {
    guard let data = try? JSONSerialization.data(withJSONObject: object, options: [.sortedKeys]) else { return }
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write(Data([10]))
    fflush(stdout)
}

private func exitError(_ message: String, code: String = "usage") -> Never {
    emit(["event": "error", "code": code, "message": message])
    exit(1)
}

private func statusName(_ status: AVAuthorizationStatus) -> String {
    switch status {
    case .authorized: return "authorized"
    case .denied: return "denied"
    case .restricted: return "restricted"
    case .notDetermined: return "notDetermined"
    @unknown default: return "unknown"
    }
}

/// Kamerarecht (TCC) des verantwortlichen Prozesses; die iOS-Bildschirmquelle gilt fuer macOS als Kamera.
/// authorized: sofort weiter. notDetermined: Anfrage (zeigt ggf. einmal den Systemdialog; fehlt dem
/// verantwortlichen Programm die Berechtigung, antwortet macOS sofort mit nein). denied/restricted: Fehler.
private func checkAccess(_ done: @escaping (Bool, String) -> Void) {
    let status = AVCaptureDevice.authorizationStatus(for: .video)
    switch status {
    case .authorized:
        done(true, statusName(status))
    case .denied, .restricted:
        done(false, statusName(status))
    default:
        let pending = DispatchWorkItem { emit(["event": "access_pending"]) }
        DispatchQueue.main.asyncAfter(deadline: .now() + 1, execute: pending)
        AVCaptureDevice.requestAccess(for: .video) { granted in
            DispatchQueue.main.async {
                pending.cancel()
                done(granted, statusName(status))
            }
        }
    }
}

private let deniedMessage = "Kein Kamerarecht (macOS-Datenschutz) fuer den startenden Prozess; die iPhone-Bildschirmquelle zaehlt als Kamera. " +
    "Aufnahme ueber das Claude-Desktop-MCP starten oder einmalig 'iphone-capture setup-app' ausfuehren und den Dialog bestaetigen."

final class USBCapture: NSObject, AVCaptureFileOutputRecordingDelegate {
    let destination: URL
    let seconds: Double
    let readStdin: Bool
    private let session = AVCaptureSession()
    private let output = AVCaptureMovieFileOutput()
    private let captureQueue = DispatchQueue(label: "iphone.usb-screen.capture")
    private var signalSources: [DispatchSourceSignal] = []
    private var runtimeObserver: NSObjectProtocol?
    private var startupDeadline: DispatchWorkItem?
    private var stopDeadline: DispatchWorkItem?
    private var durationDeadline: DispatchWorkItem?
    private var recordingRequested = false
    private var stopping = false
    private var finished = false
    private var pendingError: String?
    private var pendingCode = "capture_failed"
    private var stopReason: String?
    private var stdinBuffer = Data()
    private var discoveryDeadline = Date().addingTimeInterval(5)

    init(destination: URL, seconds: Double, readStdin: Bool) {
        self.destination = destination
        self.seconds = seconds
        self.readStdin = readStdin
        super.init()
    }

    func run() {
        // Main-Runloop bleibt frei fuer Fristen, Eingaben und AVFoundation-Delegates.
        for number in [SIGTERM, SIGINT] {
            signal(number, SIG_IGN)
            let source = DispatchSource.makeSignalSource(signal: number, queue: .main)
            source.setEventHandler { [weak self] in self?.requestStop(reason: "manual") }
            source.resume()
            signalSources.append(source)
        }
        if readStdin {
            FileHandle.standardInput.readabilityHandler = { [weak self] handle in
                let data = handle.availableData
                if data.isEmpty { handle.readabilityHandler = nil }
                DispatchQueue.main.async { self?.readInput(data) }
            }
        }
        runtimeObserver = NotificationCenter.default.addObserver(
            forName: AVCaptureSession.runtimeErrorNotification, object: session, queue: nil
        ) { [weak self] notification in
            let error = notification.userInfo?[AVCaptureSessionErrorKey] as? NSError
            let message = error?.localizedDescription ?? "USB-Bildschirmquelle wurde unterbrochen."
            DispatchQueue.main.async { self?.requestStop(reason: "device_error", error: message, code: "device_error") }
        }
        checkAccess { [weak self] granted, status in
            guard let self = self else { return }
            emit(["event": "access", "status": status, "granted": granted])
            guard granted else { self.finishError(deniedMessage, code: "camera_denied"); return }
            self.startDiscovery()
        }
    }

    private func startDiscovery() {
        guard !finished, !stopping else { return }
        let deadline = DispatchWorkItem { [weak self] in
            self?.requestStop(reason: "startup_timeout",
                              error: "USB-Aufnahme lieferte innerhalb von 15 Sekunden kein erstes Bild. iPhone entsperren.",
                              code: "startup_timeout")
        }
        startupDeadline = deadline
        DispatchQueue.main.asyncAfter(deadline: .now() + 15, execute: deadline)
        discoveryDeadline = Date().addingTimeInterval(5)

        var address = CMIOObjectPropertyAddress(
            mSelector: UInt32(kCMIOHardwarePropertyAllowScreenCaptureDevices),
            mScope: UInt32(kCMIOObjectPropertyScopeGlobal),
            mElement: UInt32(kCMIOObjectPropertyElementMain)
        )
        var enabled: UInt32 = 1
        let status = CMIOObjectSetPropertyData(
            CMIOObjectID(kCMIOObjectSystemObject), &address, 0, nil,
            UInt32(MemoryLayout<UInt32>.size), &enabled
        )
        guard status == noErr else {
            finishError("USB-Bildschirmquellen konnten nicht aktiviert werden (CoreMediaIO \(status)).", code: "cmio_failed")
            return
        }
        discover()
    }

    private func readInput(_ data: Data) {
        guard !finished else { return }
        if data.isEmpty { requestStop(reason: "manual"); return }
        stdinBuffer.append(data)
        while let newline = stdinBuffer.firstIndex(of: 10) {
            let line = String(decoding: stdinBuffer[..<newline], as: UTF8.self)
                .trimmingCharacters(in: .whitespacesAndNewlines)
            stdinBuffer.removeSubrange(...newline)
            if line == "stop" { requestStop(reason: "manual") }
        }
        if stdinBuffer.count > 4096 { stdinBuffer.removeAll(keepingCapacity: false) }
    }

    private func discover() {
        guard !finished, !stopping else { return }
        // Die veraltete muxed-Aufzaehlung liefert weiterhin die iOS-USB-Bildschirmquelle.
        // Geraetetyp und Transport schliessen Mac- und Continuity-Kameras aus.
        let devices = AVCaptureDevice.devices(for: .muxed).filter {
            $0.modelID == "iOS Device" && $0.hasMediaType(.muxed) && !$0.isContinuityCamera
        }
        if devices.count > 1 {
            finishError("Mehrere iOS-USB-Bildschirmquellen gefunden. Genau ein iPhone anschliessen.", code: "multiple_devices")
            return
        }
        if let device = devices.first {
            captureQueue.async { self.configure(device) }
            return
        }
        guard Date() < discoveryDeadline else {
            finishError("Keine iOS-USB-Bildschirmquelle gefunden. iPhone entsperren und per USB anschliessen.", code: "no_device")
            return
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.1) { self.discover() }
    }

    private func configure(_ device: AVCaptureDevice) {
        do {
            let input = try AVCaptureDeviceInput(device: device)
            session.beginConfiguration()
            if session.canSetSessionPreset(.high) { session.sessionPreset = .high }
            guard session.canAddInput(input), session.canAddOutput(output) else {
                session.commitConfiguration()
                throw NSError(domain: "USBScreen", code: 1,
                    userInfo: [NSLocalizedDescriptionKey: "USB-Bildschirmquelle ist nicht als Filmquelle verfuegbar."])
            }
            session.addInput(input)
            session.addOutput(output)
            // Nur dieses iOS-Geraet wird geoeffnet. Kein Mikrofon, kein Ton.
            for port in input.ports where port.mediaType == .audio { port.isEnabled = false }
            for connection in output.connections where connection.inputPorts.contains(where: { $0.mediaType == .audio }) {
                connection.isEnabled = false
            }
            guard let video = output.connection(with: .video), video.isEnabled else {
                session.commitConfiguration()
                throw NSError(domain: "USBScreen", code: 2,
                    userInfo: [NSLocalizedDescriptionKey: "Die iOS-USB-Quelle hat keine separate Videoverbindung (Ports: \(input.ports.map { $0.mediaType.rawValue }.joined(separator: ", ")))."])
            }
            output.maxRecordedDuration = CMTime(seconds: seconds, preferredTimescale: 60000)
            output.maxRecordedFileSize = 256 * 1024 * 1024
            output.minFreeDiskSpaceLimit = 512 * 1024 * 1024
            output.movieFragmentInterval = .invalid // Kurze Clips werden beim Stopp abgeschlossen.
            session.commitConfiguration()
            session.startRunning()
            guard session.isRunning else {
                throw NSError(domain: "USBScreen", code: 3,
                    userInfo: [NSLocalizedDescriptionKey: "USB-Bildschirmaufnahme konnte nicht gestartet werden."])
            }
            DispatchQueue.main.async { self.startRecording() }
        } catch {
            DispatchQueue.main.async { self.finishError(error.localizedDescription, code: "capture_failed") }
        }
    }

    private func startRecording() {
        guard !finished, !stopping else { return }
        guard !FileManager.default.fileExists(atPath: destination.path) else {
            finishError("Die Ausgabedatei existiert bereits; sie wird nicht ueberschrieben.", code: "exists")
            return
        }
        recordingRequested = true
        captureQueue.async { self.output.startRecording(to: self.destination, recordingDelegate: self) }
    }

    private func requestStop(reason: String, error: String? = nil, code: String? = nil) {
        guard !finished else { return }
        if let error = error, pendingError == nil { pendingError = error; pendingCode = code ?? "capture_failed" }
        if stopReason == nil { stopReason = reason }
        if stopping { return }
        stopping = true
        startupDeadline?.cancel()
        durationDeadline?.cancel()
        guard recordingRequested else {
            finishError(pendingError ?? "Aufnahme vor dem Start beendet.",
                        code: pendingError == nil ? "stopped_before_start" : pendingCode)
            return
        }
        let deadline = DispatchWorkItem { [weak self] in
            self?.finishError("USB-Aufnahme konnte innerhalb von 10 Sekunden nicht abgeschlossen werden.", code: "stop_timeout")
        }
        stopDeadline = deadline
        DispatchQueue.main.asyncAfter(deadline: .now() + 10, execute: deadline)
        captureQueue.async { self.output.stopRecording() }
    }

    func fileOutput(_ output: AVCaptureFileOutput, didStartRecordingTo fileURL: URL,
                    from connections: [AVCaptureConnection]) {
        let t = nowMs()
        DispatchQueue.main.async { [self] in
            guard !self.finished else { return }
            self.startupDeadline?.cancel()
            emit(["event": "started", "pid": Int(getpid()), "t": t])
            if self.stopping {
                self.captureQueue.async { self.output.stopRecording() }
            } else {
                // maxRecordedDuration begrenzt nativ; die Wanduhr begrenzt zusaetzlich haengende Geraete.
                let deadline = DispatchWorkItem { [weak self] in self?.requestStop(reason: "time_limit") }
                self.durationDeadline = deadline
                DispatchQueue.main.asyncAfter(deadline: .now() + self.seconds + 0.5, execute: deadline)
            }
        }
    }

    func fileOutput(_ output: AVCaptureFileOutput, didFinishRecordingTo fileURL: URL,
                    from connections: [AVCaptureConnection], error: Error?) {
        let t = nowMs()
        DispatchQueue.main.async {
            guard !self.finished else { return }
            if let pending = self.pendingError { self.finishError(pending, code: self.pendingCode); return }
            var reason = self.stopReason ?? "time_limit"
            if let error = error as NSError? {
                guard (error.userInfo[AVErrorRecordingSuccessfullyFinishedKey] as? Bool) == true else {
                    self.finishError(error.localizedDescription, code: "capture_failed")
                    return
                }
                // Datei ist gueltig, AVFoundation hat selbst gestoppt: Grund aus dem Fehlercode.
                if self.stopReason == nil || self.stopReason == "time_limit" {
                    switch error.code {
                    case AVError.Code.maximumDurationReached.rawValue: reason = "time_limit"
                    case AVError.Code.maximumFileSizeReached.rawValue: reason = "size_limit"
                    case AVError.Code.diskFull.rawValue: reason = "disk_full"
                    default: reason = "device_error"
                    }
                }
            }
            let attributes = try? FileManager.default.attributesOfItem(atPath: fileURL.path)
            guard let size = attributes?[.size] as? NSNumber, size.int64Value > 0 else {
                self.finishError("USB-Aufnahme wurde beendet, aber keine Filmdatei gespeichert.", code: "empty_file")
                return
            }
            _ = chmod(fileURL.path, S_IRUSR | S_IWUSR)
            self.finished = true
            self.cancelHandlers()
            emit(["event": "finished", "path": fileURL.path, "bytes": size.int64Value, "reason": reason, "t": t])
            // didFinish garantiert eine abgeschlossene Filmdatei. exit gibt auch das Geraet frei.
            exit(0)
        }
    }

    private func cancelHandlers() {
        startupDeadline?.cancel()
        stopDeadline?.cancel()
        durationDeadline?.cancel()
        FileHandle.standardInput.readabilityHandler = nil
        if let observer = runtimeObserver { NotificationCenter.default.removeObserver(observer) }
    }

    private func finishError(_ message: String, code: String) {
        guard !finished else { return }
        finished = true
        cancelHandlers()
        emit(["event": "error", "code": code, "message": message])
        exit(1)
    }
}

var arguments = Array(CommandLine.arguments.dropFirst())
emit(["event": "launched", "pid": Int(getpid()), "version": helperVersion])

if arguments == ["--version"] { exit(0) }
if arguments == ["--access"] {
    checkAccess { granted, status in
        emit(["event": "access", "status": status, "granted": granted])
        exit(granted ? 0 : 3)
    }
    RunLoop.main.run()
}

var readStdin = true
if let index = arguments.firstIndex(of: "--no-stdin") {
    readStdin = false
    arguments.remove(at: index)
}
guard arguments.count == 2, let seconds = Double(arguments[1]), seconds.isFinite,
      seconds >= 1, seconds <= 120 else {
    exitError("Aufruf: usb-screen [--no-stdin] AUSGABE.mov SEKUNDEN (1 bis 120) | --access | --version")
}
let destination = URL(fileURLWithPath: arguments[0]).standardizedFileURL
guard destination.pathExtension.lowercased() == "mov" else { exitError("Die Ausgabedatei muss auf .mov enden.") }
guard !FileManager.default.fileExists(atPath: destination.path) else {
    exitError("Die Ausgabedatei existiert bereits; sie wird nicht ueberschrieben.", code: "exists")
}
var directory: ObjCBool = false
guard FileManager.default.fileExists(atPath: destination.deletingLastPathComponent().path, isDirectory: &directory),
      directory.boolValue else { exitError("Der Ausgabeordner existiert nicht.") }
let recorder = USBCapture(destination: destination, seconds: seconds, readStdin: readStdin)
recorder.run()
RunLoop.main.run()
