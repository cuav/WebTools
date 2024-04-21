
var DataflashParser
import('../JsDataflashParser/parser.js').then((mod) => { DataflashParser = mod.default });

var dirHandle
async function get_dir_then_load() {

    if (typeof(window.showDirectoryPicker) != "function") {
        alert("This browser does not support directory opening.")
        return
    }

    dirHandle = await window.showDirectoryPicker().catch(() => { })

    await load_from_dir()

    // Enable reload if valid dir
    document.getElementById("reload").disabled = dirHandle == null
}

async function load_from_dir() {
    if (dirHandle == null) {
        return
    }

    const start = performance.now()

    reset()

    // Set page title to folder name
    document.title = "Logs in: " + dirHandle.name + "/"

    let progress = document.getElementById("load")
    progress.parentElement.hidden = false

    async function get_logs() {
        async function* getFilesRecursively(entry, path) {
            let relativePath
            if (path == null) {
                relativePath = entry.name
            } else {
                relativePath = path + "/" + entry.name
            }
            if (entry.kind === "file") {
                const file = await entry.getFile()
                if ((file !== null) && (file.name.toLowerCase().endsWith(".bin"))) {
                    file.relativePath = relativePath
                    yield file
                }
            } else if (entry.kind === "directory") {
                for await (const handle of entry.values()) {
                    try {
                        yield* getFilesRecursively(handle, relativePath)
                    } catch {
                        if (handle.kind === "directory") {
                            console.log("Opening " + handle.name + " in " + relativePath + " failed")
                        }
                    }
                }
            }
        }

        // Have handle, get logs

        // Do pre-count for progresses bar
        const count_start = performance.now()
        let count = 0
        for await (const fileHandle of getFilesRecursively(dirHandle)) {
            count++
        }
        console.log(`Counted ${count} logs in: ${performance.now() - count_start} ms`);
        progress.setAttribute("max", count)

        let logs = {}
        count = 0
        for await (const fileHandle of getFilesRecursively(dirHandle)) {
            count++
            progress.setAttribute("value", count)

            // Helper to allow waiting for file to load
            const wait_for_load = () => {
                const reader = new FileReader()
                return new Promise((resolve, reject) => {
                    reader.onerror = () => {
                        reader.abort()
                        reject(new DOMException("Problem parsing input file."))
                    }

                    reader.onload = () => {
                        let info = load_log(reader.result)
                        if (info == null) {
                            console.log("Load failed: " + fileHandle.relativePath)
                        } else {
                            info.name = fileHandle.name
                            info.rel_path = fileHandle.relativePath
                            logs[fileHandle.relativePath] = { info, fileHandle}
                        }
                        resolve()
                    }
                    reader.readAsArrayBuffer(fileHandle)
                })
            }

            await wait_for_load()
        }
        return logs
    }

    let logs = await get_logs()

    setup_table(logs)

    const end = performance.now();
    console.log(`Loaded ${Object.values(logs).length} logs in: ${end - start} ms`);
    progress.parentElement.hidden = true

}

function setup_table(logs) {

    // Sort in to sections based on hardware ID
    let boards = {}
    for (const log of Object.values(logs)) {
        let key = "Unknown"
        if (log.info.fc_string != null) {
            key = log.info.fc_string
        }
        if (!(key in boards)) {
            boards[key] = []
        }
        boards[key].push(log)
    }

    const tables_div = document.getElementById("tables")

    for (const [board_id, board_logs] of Object.entries(boards)) {

        function get_common_path(board_logs) {
            const first_path = board_logs[0].fileHandle.relativePath
            // Loop through the letters of the first string
            for (let i = 0; i <= first_path.length; i++) {
                // Loop through the other strings
                for (let j = 1; j < board_logs.length; j++) {
                    // Check if this character is also present in the same position of each string
                    if (first_path[i] !== board_logs[j].fileHandle.relativePath[i]) {
                        // If not, return the string up to and including the previous character
                        return first_path.slice(0, i);
                    }
                }
            }
            return first_path
        }
        const common_path = get_common_path(board_logs)

        const board_details = document.createElement("details")
        board_details.setAttribute("open", true);
        tables_div.appendChild(board_details)

        const board_summary = document.createElement("summary")
        board_summary.appendChild(document.createTextNode(board_id))
        if (common_path.length > 0) {
            board_summary.appendChild(document.createTextNode(": " + common_path))
        }
        board_summary.style.fontSize = " 1.17em"
        board_summary.style.fontWeight = "bold"
        board_details.style.marginBottom = "15px"
        board_details.appendChild(board_summary)

        board_details.appendChild(document.createElement("br"))

        const table_div = document.createElement("div")
        table_div.style.width = "1200px"
        board_details.appendChild(table_div)

        // custom formatter to add a param download button
        function param_download_button(cell, formatterParams, onRendered) {

            function save_parameters() {
                const log = cell.getRow().getData()
                const params = log.info.params

                if (Object.keys(params).length == 0) {
                    return
                }

                // Get contents of file to download
                const text = get_param_download_text(params)

                // make sure there are no slashes in file name
                let log_file_name = log.info.name.replace(/.*[\/\\]/, '')

                // Replace the file extension
                const file_name = (log_file_name.substr(0, log_file_name.lastIndexOf('.')) || log_file_name) + ".param"

                // Save
                var blob = new Blob([text], { type: "text/plain;charset=utf-8" })
                saveAs(blob, file_name)
            }

            let button = document.createElement("input")
            button.setAttribute('value', 'Parameters')
            button.setAttribute('type', 'button')
            button.addEventListener("click", save_parameters)
            button.disabled = Object.keys(cell.getRow().getData().info.params).length == 0

            // Dynamically update tool tip to show param diff
            function tippy_show(instance) {
                const prev_row = cell.getRow().getPrevRow()
                if (prev_row === false) {
                    // Don't show if there is no previous row
                    return false
                }

                const prev_params = prev_row.getData().info.params
                const params = cell.getRow().getData().info.params

                // Superset of param names from both files
                const names = new Set([...Object.keys(prev_params), ...Object.keys(params)])

                // Do param diff
                let added = {}
                let missing = {}
                let changed = {}
                for (const name of names) {
                    const have_old = name in prev_params
                    const have_new = name in params
                    if (have_new && !have_old) {
                        // Only in new
                        added[name] = params[name]

                    } else if (!have_new && have_old) {
                        // Only in old
                        missing[name] = prev_params[name]

                    } else if (prev_params[name] != params[name]) {
                        // In both with different value

                        // Check if this change should be ignored
                        let show_change = true
                        for (const ignore of param_diff_ignore) {
                            if (ignore.check.checked && ignore.fun(name)) {
                                show_change = false
                                break
                            }
                        }

                        if (show_change) {
                            changed[name] = { from: prev_params[name], to: params[name]}
                        }
                    }
                }

                let tippy_div = document.createElement("div")
                instance.setContent(tippy_div)

                const have_added = Object.keys(added).length > 0
                const have_missing = Object.keys(missing).length > 0
                const have_changed = Object.keys(changed).length > 0

                if (!have_added && !have_missing && !have_changed) {
                    tippy_div.appendChild(document.createTextNode("No change"))
                    return
                }

                tippy_div.style.width = '500px';
                tippy_div.style.maxHeight = '90vh';
                tippy_div.style.overflow = 'auto';

                if (have_added) {
                    const details = document.createElement("details")
                    details.setAttribute("open", true);
                    details.style.marginBottom = "5px"
                    tippy_div.appendChild(details)

                    const summary = document.createElement("summary")
                    summary.appendChild(document.createTextNode("New:"))
                    details.appendChild(summary)

                    for (const [name, value] of Object.entries(added)) {
                        const text = name + ": " + param_to_string(value)
                        details.appendChild(document.createTextNode(text))
                        details.appendChild(document.createElement("br"))
                    }
                }

                if (have_missing) {
                    const details = document.createElement("details")
                    details.setAttribute("open", true);
                    details.style.marginBottom = "5px"
                    tippy_div.appendChild(details)

                    const summary = document.createElement("summary")
                    summary.appendChild(document.createTextNode("Missing:"))
                    details.appendChild(summary)

                    for (const [name, value] of Object.entries(missing)) {
                        const text = name + ": " + param_to_string(value)
                        details.appendChild(document.createTextNode(text))
                        details.appendChild(document.createElement("br"))
                    }
                }

                if (have_changed) {
                    const details = document.createElement("details")
                    details.setAttribute("open", true);
                    details.style.marginBottom = "5px"
                    tippy_div.appendChild(details)

                    const summary = document.createElement("summary")
                    summary.appendChild(document.createTextNode("Changed:"))
                    details.appendChild(summary)

                    for (const [name, values] of Object.entries(changed)) {
                        const text = name + ": " + param_to_string(values.from) + " => " + param_to_string(values.to)
                        details.appendChild(document.createTextNode(text))
                        details.appendChild(document.createElement("br"))
                    }
                }

            }

            tippy(button, {
                maxWidth: '750px',
                placement: 'left',
                interactive: true,
                appendTo: () => document.body,
                onShow: tippy_show
            })

            return button
        }

        // custom formatter to add a open in button
        function open_in_button(cell, formatterParams, onRendered) {

            // Button to hold tool tip
            let button = document.createElement("input")
            button.setAttribute('value', 'Open In')
            button.setAttribute('type', 'button')

            function get_file_fun() {
                return cell.getRow().getData().fileHandle
            }

            tippy(button, {
                content: open_in_tippy_div(get_file_fun),
                placement: 'left',
                interactive: true,
                appendTo: () => document.body,
            })
            return button
        }

        // Formatter to add custom buttons
        function check_warnings(cell, formatterParams, onRendered) {
            const log = cell.getRow().getData()
            const arming_checks_disabled = ("ARMING_CHECK" in log.info.params) && (log.info.params["ARMING_CHECK"] == 0)
            if (!arming_checks_disabled && !log.info.watchdog && !log.info.crash_dump) {
                // Nothing to warn about
                return
            }

            let img = document.createElement("img")
            img.style.width = "20px"
            img.style.verticalAlign = "bottom"

            if (log.info.crash_dump || log.info.watchdog) {
                img.src = "../images/exclamation-triangle-red.svg"

            } else {
                // Arming checks 0
                img.src = "../images/exclamation-triangle-orange.svg"

            }

            let tippy_div = document.createElement("div")

            if (log.info.crash_dump) {
                const para = document.createElement("p")
                tippy_div.appendChild(para)
                para.appendChild(document.createTextNode("Crash Dump file detected, please report to dev team."))
            }

            if (log.info.watchdog) {
                const para = document.createElement("p")
                tippy_div.appendChild(para)
                para.appendChild(document.createTextNode("Watchdog reboot detected."))
            }

            if (arming_checks_disabled) {
                const para = document.createElement("p")
                tippy_div.appendChild(para)
                para.appendChild(document.createTextNode("Arming checks disabled."))
            }

            tippy(img, {
                content: tippy_div,
                placement: 'left',
                interactive: true,
                appendTo: () => document.body,
            })

            return img
        }

        // Formatter to add custom buttons
        function buttons(cell, formatterParams, onRendered) {
            let div = document.createElement("div")
            div.appendChild(param_download_button(cell, formatterParams, onRendered))
            div.appendChild(document.createTextNode(" "))
            div.appendChild(open_in_button(cell, formatterParams, onRendered))

            const warning = check_warnings(cell, formatterParams, onRendered)
            if (warning != null) {
                div.appendChild(document.createTextNode(" "))
                div.appendChild(warning)
            }
            return div
        }

        // Name formatter to add path on tooltip
        function name_format(cell, formatterParams, onRendered) {
            let div = document.createElement("div")
            const file = cell.getRow().getData().fileHandle
            if (file == null) {
                return
            }
            div.appendChild(document.createTextNode(file.name))

            tippy(div, {
                content: file.relativePath,
                interactive: true,
                appendTo: () => document.body,
            })

            return div
        }

        // Make file size a nice string with units
        function size_format(cell, formatterParams, onRendered) {
            const size = cell.getRow().getData().info.size
            const unit_array = ['B', 'kB', 'MB', 'GB', 'TB']
            const unit_index = (size == 0) ? 0 : Math.floor(Math.log(size) / Math.log(1024))
            const scaled_size = size / Math.pow(1024, unit_index)
            return scaled_size.toFixed(2) + " " + unit_array[unit_index]
        }

        // Make flight time a nice string with units
        function flight_time_format(cell, formatterParams, onRendered) {
            const flight_time = cell.getRow().getData().info.flight_time
            if (flight_time == null) {
                return "Unknown"
            }

            // Try human readable
            if (flight_time == 0) {
                return "-"
            }
            const dur = luxon.Duration.fromMillis(flight_time * 1000)
            return dur.rescale().toHuman({listStyle: 'narrow', unitDisplay: 'short'})

            // Might like this better, not sure
            //return dur.toFormat("hh:mm:ss")
        }

        new Tabulator(table_div, {
            height: "fit-content",
            data: board_logs,
            index: "info.rel_path",
            layout: "fitColumns",
            columns: [
                {
                    title: "Date",
                    field: "info.time_stamp",
                    width: 160,
                    formatter:"datetime",
                    formatterParams: {
                        outputFormat: "dd/MM/yyyy hh:mm:ss a",
                        invalidPlaceholder: "No GPS",
                    },
                    sorter:"datetime",
                },
                { title: "Name", field: "info.name", formatter:name_format },
                { title: "Size", field: "info.size", formatter:size_format },
                { title: "Firmware Version", field:"info.fw_string" },
                { title: "Flight Time", field:"info.flight_time", formatter:flight_time_format },
                { title: "" , headerSort:false, formatter:buttons, width: 185 },
            ],
            initialSort: [
                { column:"info.time_stamp", dir:"asc"},
            ]
        })

    }

}

function load_log(log_file) {

    let log = new DataflashParser()
    try {
        log.processData(log_file, [])
    } catch {
        return
    }

    let fw_string
    let git_hash
    let board_id
    let fc_string
    let os_string
    let board_name
    let vehicle_type

    if ('VER' in log.messageTypes) {
        const VER = log.get("VER")

        // Assume version does not change, just use first msg
        fw_string = VER.FWS[0]
        git_hash = VER.GH[0].toString(16)
        if (VER.APJ[0] != 0) {
            board_id = VER.APJ[0]
        }
        if ("BU" in VER) {
            vehicle_type = VER.BU[0]
        }
    }


    if ('MSG' in log.messageTypes) {
        const MSG = log.get("MSG")
        // Look for firmware string in MSGs, this marks the start of the log start msgs
        // The subsequent messages give more info, this is a bad way of doing it
        const len = MSG.Message.length
        for (let i = 0; i < len - 3; i++) {
            const msg = MSG.Message[i]
            if (fw_string != null) {
                // If we have a firmware string it should match the message
                if (fw_string != msg) {
                    continue
                }

            } else {
                const vehicles = ["ArduPlane V", "ArduCopter V", "Blimp V", "ArduRover V", "ArduSub V", "AntennaTracker V"]
                let found_match = false
                for (const vehicle of vehicles) {
                    if (msg.startsWith(vehicle)) {
                        fw_string = msg
                        found_match = true
                        break
                    }
                }
                if (!found_match) {
                    continue
                }
            }
            if ((fw_string != null) && (fw_string != msg)) {
                continue
            }
            if (!MSG.Message[i+3].startsWith("Param space used:")) {
                // Check we have bracketed the messages we need
                continue
            }
            os_string = MSG.Message[i+1]
            fc_string = MSG.Message[i+2]
            break
        }
    }

    // Populate the board name from boards lookup
    if ((board_id != null) && (board_id in board_types)) {
        board_name = board_types[board_id]
    }

    // Get params, extract flight time
    const PARM = log.get("PARM")
    let params = {}
    let start_flight_time
    let end_flight_time
    for (let i = 0; i < PARM.Name.length; i++) {
        const name = PARM.Name[i]
        const value = PARM.Value[i]
        params[name] = value

        // Check for cumulative flight time, get first and last value
        if (name == "STAT_FLTTIME") {
            if (start_flight_time == null) {
                start_flight_time = value
            }
            end_flight_time = value
        }
    }

    let flight_time
    if (start_flight_time != null) {
        flight_time = end_flight_time - start_flight_time
    }

    // Get start time, convert to luxon format to work with table
    const time_stamp = luxon.DateTime.fromJSDate(log.extractStartTime())

    // Check for bad things we should warn about
    const watchdog = 'WDOG' in log.messageTypes

    let crash_dump
    if ('FILE' in log.messageTypes) {
        crash_dump = false
        const names = log.get('FILE', 'FileName')
        const len = names.length
        for (let i = 0; i<len; i++) {
            if (names[i].endsWith("crash_dump.bin")) {
                crash_dump = true
                break
            }
        }
    }

    return {
        size: log_file.byteLength,
        fw_string,
        git_hash,
        board_id,
        fc_string,
        os_string,
        board_name,
        vehicle_type,
        params,
        time_stamp,
        flight_time,
        watchdog,
        crash_dump
    }
}

function reset() {

    // Reset title
    document.title = "ArduPilot Log Finder"

    // Remove all tables
    document.getElementById("tables").replaceChildren()

    // Reset progress
    let progress = document.getElementById("load")
    progress.setAttribute("value", 0)
    progress.setAttribute("max", 0)
    progress.parentElement.hidden = true
}

let param_diff_ignore = [
    { name: "Statistics (STAT_)", fun: (name) => { return name.startsWith("STAT_") || (name == "SYS_NUM_RESETS") } },
    { name: "Gyro offsets", fun: (name) => { return /(:?(INS)[45]?_(GYR)[23]?(OFFS_)[XYZ])/gm.test(name)} },
    { name: "Gyro cal temperature", fun: (name) => { return /(:?(INS)[45]?(_GYR)[123]?(_CALTEMP))/gm.test(name)} },
    { name: "Baro ground pressure", fun: (name) => { return /(:?(BARO)[123]?(_GND_PRESS))/gm.test(name)} },
    { name: "Compass declination", fun: (name) => { return name == "COMPASS_DEC"} },
    { name: "Airspeed offset", fun: (name) => { return /(:?(ARSPD)[123]?(_OFFSET))/gm.test(name)} },
    { name: "Stream rates", fun: (name) => {
        return /(:?(SR)[0123456]_(RAW_SENS))/gm.test(name) ||
            /(:?(SR)[0123456]_(EXT_STAT))/gm.test(name) ||
            /(:?(SR)[0123456]_(RC_CHAN))/gm.test(name) ||
            /(:?(SR)[0123456]_(RAW_CTRL))/gm.test(name) ||
            /(:?(SR)[0123456]_(POSITION))/gm.test(name) ||
            /(:?(SR)[0123456]_(EXTRA1))/gm.test(name) ||
            /(:?(SR)[0123456]_(EXTRA2))/gm.test(name) ||
            /(:?(SR)[0123456]_(EXTRA3))/gm.test(name) ||
            /(:?(SR)[0123456]_(PARAMS))/gm.test(name) ||
            /(:?(SR)[0123456]_(ADSB))/gm.test(name)
        }
    },
]

let board_types = {}
async function initial_load() {

    document.getElementById("reload").disabled = true

    const fieldset = document.getElementById("param_diff_ignore")
    for (let i=0; i<param_diff_ignore.length; i++) {
        if (i > 0) {
            fieldset.appendChild(document.createTextNode(", "))
        }

        const ignore = param_diff_ignore[i]
        const id = "param_diff_ignore" + i

        ignore.check = document.createElement("input")
        ignore.check.setAttribute('type', 'checkbox')
        ignore.check.setAttribute('id', id)
        ignore.check.checked = true

        let label = document.createElement("label")
        label.setAttribute('for', id)
        label.appendChild(document.createTextNode(ignore.name))

        fieldset.appendChild(ignore.check)
        fieldset.appendChild(label)
    }

    function load_board_types(text) {
        const lines = text.match(/[^\r\n]+/g)
        for (const line of lines) {
            // This could be combined with the line split if I was better at regex's
            const match = line.match(/(^[-\w]+)\s+(\d+)/)
            if (match) {
                const board_id = match[2]
                let board_name = match[1]

                // Shorten name for readability
                board_name = board_name.replace(/^TARGET_HW_/, "")
                board_name = board_name.replace(/^EXT_HW_/, "")
                board_name = board_name.replace(/^AP_HW_/, "")

                board_types[board_id] = board_name
            }
        }
    }


    fetch("board_types.txt")
        .then((res) => {
        return res.text();
    }).then((data) => load_board_types(data));

    if (typeof(window.showDirectoryPicker) != "function") {
        alert("This browser does not support directory opening.")
    }

}
