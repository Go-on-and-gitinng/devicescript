import { parseStackFrame } from "@devicescript/compiler"
import { ChildProcess, fork, spawn } from "node:child_process"
import { wrapColor } from "./logging"
import {
    addReqHandler,
    DevToolsClient,
    devtoolsIface,
    sendOutput,
} from "./sidedata"
import {
    OutputFrom,
    SideStartVmReq,
    SideStartVmResp,
    SideStopVmReq,
    SideStopVmResp,
} from "./sideprotocol"

let worker: ChildProcess

export function waitForEvent<T>(
    ms: number,
    f: (cb: (v?: T) => void) => void
): Promise<T | undefined> {
    let done = false
    return new Promise<T>(resolve => {
        const resolveWrapped = (v: T) => {
            if (!done) {
                done = true
                resolve(v)
            }
        }
        f(resolveWrapped)
        setTimeout(() => resolveWrapped(undefined), ms)
    })
}

export function lineBuffer(cb: (lines: string[]) => void) {
    let acc = ""
    let to: any
    const flush = () => {
        to = null
        if (acc) {
            const lines = [acc]
            acc = ""
            cb(lines)
        }
    }
    return (str: string) => {
        if (str.includes("\r")) str = str.replace(/\r/g, "")
        if (acc) str = acc + str
        if (str.includes("\n")) {
            const lines = str.split("\n")
            acc = lines.pop()
            cb(lines)
        } else {
            acc = str
        }
        if (to) clearTimeout(to)
        if (acc) to = setTimeout(flush, 200)
    }
}

export async function stopVmWorker() {
    if (worker) {
        try {
            if (worker.exitCode === null && worker.signalCode === null) {
                worker.kill()
                await waitForEvent(500, f => worker.on("exit", f))
            }
            worker.kill("SIGKILL")
        } catch {}
        worker = null
    }
}

export function overrideConsoleDebug() {
    const dbg = console.debug
    console.debug = (...args: any[]) => {
        const cl = devtoolsIface?.mainClient
        if (
            cl &&
            args.length == 1 &&
            typeof args[0] == "string" &&
            args[0].startsWith("DEV: ")
        ) {
            let line = args[0].replace(/\x1B\[[0-9;]+m/g, "").slice(5)
            sendOutput(cl, "dev", [line])
            line = line.replace(/^DM \(\d+\): ?/, "")
            if (line) printDmesg(line)
        } else {
            if (cl) {
                let str = ""
                for (const a of args) {
                    if (str) str += " "
                    str += a
                }
                sendOutput(cl, "verbose", [str])
            } else {
                dbg(...args)
            }
        }
    }
}

export function printDmesg(line: string) {
    const m = /^\s*([\*\!>]) (.*)/.exec(line)
    if (m) {
        let [_full, marker, text] = m
        const dbg = devtoolsIface.lastOKBuild?.dbg
        if (dbg) text = parseStackFrame(dbg, text).markedLine
        if (marker == "!") text = wrapColor(91, text)
        else if (marker == ">") text = wrapColor(95, text)
        else text = wrapColor(92, text)
        console.log("VM> " + text)
    }
}

export async function startVmWorker(
    req: SideStartVmReq,
    sender: DevToolsClient
) {
    const args = req.data
    await stopVmWorker()

    if (args.nativePath) {
        const vargs = ["-n", "-w", "8082"]
        if (args.gcStress) vargs.push("-X")
        if (args.deviceId) vargs.push("-d:" + args.deviceId)
        console.debug("starting", args.nativePath, vargs.join(" "))
        worker = spawn(args.nativePath, vargs, {
            shell: false,
        })
    } else {
        const vargs = ["vm", "--devtools"]
        if (args.deviceId) vargs.push("--device-id", args.deviceId)
        if (args.gcStress) vargs.push("--gc-stress")
        console.debug("starting", __filename, vargs.join(" "))
        worker = fork(__filename, vargs, { silent: true })
    }

    worker.stdin.end()
    worker.stdout.setEncoding("utf-8")
    worker.stderr.setEncoding("utf-8")

    worker.on("exit", (code, signal) => {
        sendOutput(sender, "vm-err", [`Exit code: ${code} ${signal ?? ""}`])
    })

    function buffered(kind: OutputFrom) {
        return lineBuffer(lines => {
            sendOutput(sender, kind, lines)
            for (const l of lines) {
                if (l.startsWith("    ")) printDmesg(l.slice(4))
            }
        })
    }

    worker.stdout.on("data", buffered("vm"))
    worker.stderr.on("data", buffered("vm-err"))
    return {}
}

export function initVMCmds() {
    addReqHandler<SideStartVmReq, SideStartVmResp>("startVM", startVmWorker)
    addReqHandler<SideStopVmReq, SideStopVmResp>("stopVM", stopVmWorker)
}
