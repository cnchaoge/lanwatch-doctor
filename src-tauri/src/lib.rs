#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use serde::Serialize;
use std::process::Command;

const EXTERNAL_IP: &str = "223.5.5.5";

#[derive(Serialize, Clone, Default)]
pub struct WifiLink {
    pub connected: bool,
    pub rssi: i32,
    pub noise: i32,
    pub channel: u32,
    pub band: String,
    pub tx_rate: i64,
}

#[derive(Serialize, Clone)]
pub struct NetworkInfo {
    pub wifi: WifiLink,
    pub wired_connected: bool,
    pub interface: String,
    pub ip: String,
    pub gateway: String,
    pub subnet_mask: String,
    pub dns: Vec<String>,
    pub mac: String,
    pub hardware_port: String,
    pub wifi_name: String,
}

fn run_cmd(cmd: &str, args: &[&str]) -> String {
    Command::new(cmd)
        .args(args)
        .output()
        .map(|o| String::from_utf8_lossy(&o.stdout).to_string())
        .unwrap_or_default()
}

fn read_file(path: &str) -> String {
    std::fs::read_to_string(path).unwrap_or_default()
}

/// Find the interface that carries the default route (the "primary" interface)
fn get_primary_interface() -> (String, String) {
    let route = run_cmd("route", &["-n", "get", "default"]);
    let mut iface = String::new();
    let mut gateway = String::new();

    for line in route.lines() {
        let t = line.trim();
        if t.starts_with("interface:") {
            iface = t["interface:".len()..].trim().to_string();
        } else if t.starts_with("gateway:") {
            gateway = t["gateway:".len()..].trim().to_string();
        }
    }
    (iface, gateway)
}

const AIRPORT_PATH: &str =
    "/System/Library/PrivateFrameworks/Apple80211.framework/Versions/Current/Resources/airport";

/// Locate the bundled CoreWLAN helper. In dev it lives next to the Cargo
/// manifest; in a packaged app it sits in the resource directory.
fn wifi_helper_paths(app: &tauri::AppHandle) -> Vec<std::path::PathBuf> {
    use tauri::Manager;
    let mut paths = Vec::new();
    if let Ok(dir) = app.path().resource_dir() {
        paths.push(dir.join("wifi-helper"));
    }
    // Dev fallback: resources/ next to Cargo.toml
    paths.push(
        std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources").join("wifi-helper"),
    );
    paths
}

/// Ask the CoreWLAN helper for the Wi-Fi link quality.
/// Returns None when the helper is unavailable or returns nothing usable.
fn read_wifi_helper(app: &tauri::AppHandle, iface: &str) -> Option<WifiLink> {
    for path in wifi_helper_paths(app) {
        if !path.exists() {
            continue;
        }
        let out = match Command::new(&path).arg(iface).output() {
            Ok(o) => o,
            Err(_) => continue,
        };
        let text = String::from_utf8_lossy(&out.stdout);
        let v: serde_json::Value = serde_json::from_str(text.trim()).ok()?;
        let valid = v.get("rssiValid").and_then(|x| x.as_bool()).unwrap_or(false);
        return Some(WifiLink {
            connected: valid,
            rssi: v.get("rssi").and_then(|x| x.as_i64()).unwrap_or(0) as i32,
            noise: v.get("noise").and_then(|x| x.as_i64()).unwrap_or(0) as i32,
            channel: v.get("channel").and_then(|x| x.as_u64()).unwrap_or(0) as u32,
            band: v.get("band").and_then(|x| x.as_str()).unwrap_or("").to_string(),
            tx_rate: v.get("txRate").and_then(|x| x.as_i64()).unwrap_or(0),
        });
    }
    None
}

fn get_wifi_info(app: &tauri::AppHandle, iface: &str) -> WifiLink {
    // CoreWLAN helper — authoritative link-quality source on modern macOS.
    if let Some(link) = read_wifi_helper(app, iface) {
        if link.connected || link.channel > 0 {
            return link;
        }
    }

    // Fallback: the legacy `airport` tool, when it still exists.
    if !iface.is_empty() {
        let out = run_cmd(AIRPORT_PATH, &["-I"]);
        let rssi = out
            .lines()
            .find(|l| l.trim().starts_with("agrCtlRSSI"))
            .and_then(|l| l.split(':').nth(1))
            .and_then(|s| s.trim().parse::<i32>().ok())
            .unwrap_or(0);
        let noise = out
            .lines()
            .find(|l| l.trim().starts_with("agrCtlNoise"))
            .and_then(|l| l.split(':').nth(1))
            .and_then(|s| s.trim().parse::<i32>().ok())
            .unwrap_or(0);
        if rssi != 0 {
            return WifiLink {
                connected: true,
                rssi,
                noise,
                ..Default::default()
            };
        }
    }

    WifiLink::default()
}

/// Convert a hex netmask (0xffffff00) to dotted decimal (255.255.255.0)
fn hex_mask_to_dotted(hex: &str) -> String {
    let h = hex.trim().trim_start_matches("0x").trim_start_matches("0X");
    match u32::from_str_radix(h, 16) {
        Ok(v) => format!("{}.{}.{}.{}", (v >> 24) & 0xff, (v >> 16) & 0xff, (v >> 8) & 0xff, v & 0xff),
        Err(_) => hex.to_string(),
    }
}

fn get_ip_and_mask(iface: &str) -> (String, String) {
    if iface.is_empty() {
        return (String::new(), String::new());
    }
    let ifconfig = run_cmd("ifconfig", &[iface]);
    let mut ip = String::new();
    let mut mask = String::new();

    for line in ifconfig.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with("inet ") && !trimmed.starts_with("inet6") {
            let parts: Vec<&str> = trimmed.split_whitespace().collect();
            if parts.len() >= 4 {
                ip = parts[1].to_string();
                mask = hex_mask_to_dotted(parts[3]);
            }
            break;
        }
    }

    (ip, mask)
}

fn get_mac(iface: &str) -> String {
    if iface.is_empty() {
        return String::new();
    }
    let ifconfig = run_cmd("ifconfig", &[iface]);
    for line in ifconfig.lines() {
        let trimmed = line.trim();
        if let Some(rest) = trimmed.strip_prefix("ether ") {
            let raw = rest.split_whitespace().next().unwrap_or("");
            return raw.trim().to_uppercase().replace(':', "-");
        }
    }
    String::new()
}

fn hardware_port_for(iface: &str) -> String {
    if iface.is_empty() {
        return String::new();
    }
    let out = run_cmd("networksetup", &["-listallhardwareports"]);
    let mut port = String::new();
    for line in out.lines() {
        let t = line.trim();
        if let Some(name) = t.strip_prefix("Hardware Port:") {
            port = name.trim().to_string();
        } else if let Some(dev) = t.strip_prefix("Device:") {
            if dev.trim() == iface {
                return port;
            }
        }
    }
    String::new()
}

fn wifi_ssid(iface: &str) -> String {
    if iface.is_empty() {
        return String::new();
    }
    let out = run_cmd("networksetup", &["-getairportnetwork", iface]);
    for line in out.lines() {
        if let Some(rest) = line.trim().strip_prefix("Current Wi-Fi Network:") {
            let name = rest.trim();
            if !name.is_empty() {
                return name.to_string();
            }
        }
    }
    String::new()
}

fn is_wifi_port(port: &str) -> bool {
    let p = port.to_lowercase();
    p.contains("wi-fi") || p.contains("wifi") || p.contains("airport")
}

fn get_dns() -> Vec<String> {
    let resolv = read_file("/etc/resolv.conf");
    let all: Vec<String> = resolv
        .lines()
        .filter(|l| l.trim().starts_with("nameserver"))
        .filter_map(|l| l.split_whitespace().nth(1))
        .map(|s| s.to_string())
        .collect();

    // Prefer IPv4 over IPv6 link-local
    let ipv4: Vec<String> = all.iter().filter(|s| !s.starts_with("fe80") && !s.contains(':')).cloned().collect();
    if !ipv4.is_empty() {
        ipv4
    } else {
        all
    }
}

#[tauri::command]
fn get_network_info(app: tauri::AppHandle) -> NetworkInfo {
    let (iface, gateway) = get_primary_interface();
    let (ip, mask) = get_ip_and_mask(&iface);
    let dns = get_dns();
    let port = hardware_port_for(&iface);
    let mac = get_mac(&iface);
    let wifi_port = is_wifi_port(&port);
    let mut wifi = get_wifi_info(&app, &iface);
    let online = !ip.is_empty();
    if wifi_port && online {
        wifi.connected = true;
    } else if !wifi_port {
        wifi.connected = false;
    }
    let wired_connected = online && !wifi.connected;
    let wifi_name = if wifi.connected { wifi_ssid(&iface) } else { String::new() };

    NetworkInfo {
        wifi,
        wired_connected,
        interface: iface,
        ip,
        gateway,
        subnet_mask: mask,
        dns,
        mac,
        hardware_port: port,
        wifi_name,
    }
}

// ========== ARP & Security Detection ==========

#[derive(Clone)]
struct ArpEntry {
    ip: String,
    mac: String,
}

fn get_arp_table() -> Vec<ArpEntry> {
    let output = run_cmd("arp", &["-a"]);
    let mut entries = Vec::new();

    // macOS arp -a format: ? (192.168.8.1) at aa:bb:cc:dd:ee:ff on en0
    for line in output.lines() {
        let parts: Vec<&str> = line.split_whitespace().collect();
        if parts.len() >= 4 {
            let ip = parts.get(1)
                .unwrap_or(&"")
                .trim_start_matches('(')
                .trim_end_matches(')')
                .to_string();
            let mac = parts.get(3).unwrap_or(&"").to_string();
            if !ip.is_empty() && !mac.is_empty() && ip != "(incomplete)" {
                entries.push(ArpEntry { ip, mac });
            }
        }
    }
    entries
}

const OUI_TP_LINK: &[&str] = &[
    "50C7BF", "A42BB0", "1C61B4", "60E327", "3400A3", "542B10", "687251", "704E77",
    "8863DF", "9C5322", "AC84C6", "C46E1F", "D807D2", "EC086B", "F4F1E1", "B09575",
    "DCFE18", "1CA6B4", "5CC9C4", "98DAE4", "E8BE8D", "0C9D4E",
];

const OUI_TENDA: &[&str] = &[
    "001731", "0019E0", "00E018", "2CAB25", "388345", "4C1FCC", "5C628B", "80FA5B",
    "94A7B7", "A8F94B", "C83A35", "D03745", "E892A4", "202BC2", "CC3E8D", "4C3D74",
];

const OUI_MERCURY: &[&str] = &[
    "001132", "001D0F", "308730", "344DEA", "3C3332", "44D9E7", "54E6C0", "64517E",
    "6C7220", "708A5D", "7CA23E", "8056C2", "9CC172", "BC9680", "C864C7", "D4024A",
    "E005C5", "F81EDF", "B47C9C", "D8F31C", "24E9FB",
];

const OUI_XIAOMI: &[&str] = &[
    "28987B", "2C4D54", "4432C8", "488AD2", "50EC50", "54EF44", "586B14", "648B01",
    "6C5AB0", "64B473", "74DA88", "8C210A", "A08CF8", "B07FB9", "C4E90A", "DC78D7",
];

const OUI_HUAWEI: &[&str] = &[
    "001E10", "048C9A", "0C37DC", "24DBAC", "048FC5", "AC0875", "E0247F", "5C4CA9",
];

fn mac_vendor(mac: &str) -> &'static str {
    let prefix: String = mac.to_uppercase().replace(':', "").chars().take(6).collect();
    if OUI_TP_LINK.contains(&prefix.as_str()) { return "TP-Link" }
    if OUI_TENDA.contains(&prefix.as_str()) { return "Tenda" }
    if OUI_MERCURY.contains(&prefix.as_str()) { return "Mercury" }
    if OUI_XIAOMI.contains(&prefix.as_str()) { return "Xiaomi" }
    if OUI_HUAWEI.contains(&prefix.as_str()) { return "Huawei" }
    ""
}

fn detect_ip_conflicts(arp: &[ArpEntry]) -> Vec<IpConflict> {
    use std::collections::HashMap;
    let mut ip_macs: HashMap<String, Vec<String>> = HashMap::new();

    for entry in arp {
        let macs = ip_macs.entry(entry.ip.clone()).or_default();
        if !macs.contains(&entry.mac) {
            macs.push(entry.mac.clone());
        }
    }

    ip_macs
        .into_iter()
        .filter(|(_, macs)| macs.len() > 1)
        .map(|(ip, macs)| IpConflict { ip, macs })
        .collect()
}

fn detect_rogue_devices(arp: &[ArpEntry], gateway: &str) -> Vec<RogueDevice> {
    let mut rogues = Vec::new();

    for entry in arp {
        if entry.ip == gateway { continue; }

        let vendor = mac_vendor(&entry.mac);
        if vendor.is_empty() { continue; }

        // Router vendors on non-gateway IPs are suspicious
        let is_private = entry.ip.starts_with("192.168.") || entry.ip.starts_with("10.") || entry.ip.starts_with("172.");
        if !is_private { continue; }

        // Common router default IPs
        let is_router_ip = entry.ip.ends_with(".1") || entry.ip.ends_with(".254") || entry.ip.ends_with(".253");

        let confidence = if is_router_ip { 90 } else { 60 };

        rogues.push(RogueDevice {
            ip: entry.ip.clone(),
            mac: entry.mac.clone(),
            vendor: vendor.to_string(),
            confidence,
        });
    }

    rogues.sort_by(|a, b| b.confidence.cmp(&a.confidence));
    rogues
}

// ========== Route Trace (NextTrace) ==========

#[derive(Serialize, Clone)]
pub struct TraceHop {
    pub ttl: u32,
    pub ip: String,
    pub hostname: String,
    pub rtt_ms: f64,
    pub location: String,
    pub asn: String,
}

#[derive(Serialize, Clone)]
pub struct TraceResult {
    pub hops: Vec<TraceHop>,
    pub maptrace_url: String,
    pub error: String,
    pub duration_ms: u64,
    pub target: String,
}

#[tauri::command]
fn trace_route(target: String) -> TraceResult {
    let start = std::time::Instant::now();
    let output = Command::new("traceroute")
        .args(&["-m", "15", "-w", "2", &target])
        .output();

    match output {
        Ok(o) => {
            let stdout = String::from_utf8_lossy(&o.stdout);
            let stderr = String::from_utf8_lossy(&o.stderr);
            let mut hops = Vec::new();

            for line in stdout.lines() {
                let line = line.trim();
                if line.is_empty() { continue; }

                // Parse: " 1  192.168.8.1 (192.168.8.1)  4.7ms  3.8ms  3.3ms"
                // or:    " 2  * * *"
                let parts: Vec<&str> = line.split_whitespace().collect();
                if parts.len() < 2 { continue; }

                let ttl: u32 = parts[0].parse().ok().unwrap_or(0);
                if ttl == 0 { continue; }

                let all_timeout = parts[1..].iter().all(|&p| p == "*");
                if all_timeout {
                    hops.push(TraceHop { ttl, ip: "*".to_string(), hostname: String::new(), rtt_ms: 0.0, location: String::new(), asn: String::new() });
                    continue;
                }

                // Tokenize: "1  hostname (ip)  2.9 ms  3.8 ms  3.3 ms"
                // macOS/Linux both use "<num> ms" (space separated) or "<num>ms"
                let mut ip = String::new();
                let mut hostname = String::new();
                let mut rtt_ms = 0.0f64;
                let mut idx = 1;

                while idx < parts.len() {
                    let part = parts[idx];

                    if part == "*" { idx += 1; continue; }

                    // "<num> ms" — two separate tokens
                    if idx + 1 < parts.len() && parts[idx + 1] == "ms" {
                        if let Ok(ms) = part.parse::<f64>() {
                            if rtt_ms == 0.0 || ms < rtt_ms { rtt_ms = ms; }
                        }
                        idx += 2;
                        continue;
                    }

                    // "<num>ms" — single token
                    if part.ends_with("ms") {
                        if let Ok(ms) = part.trim_end_matches("ms").trim().parse::<f64>() {
                            if rtt_ms == 0.0 || ms < rtt_ms { rtt_ms = ms; }
                        }
                        idx += 1;
                        continue;
                    }

                    // "(ip)" — address in parentheses
                    if part.starts_with('(') && part.ends_with(')') {
                        if ip.is_empty() { ip = part[1..part.len() - 1].to_string(); }
                        idx += 1;
                        continue;
                    }

                    // Bare hostname or IP (no reverse DNS)
                    if ip.is_empty() && hostname.is_empty() {
                        if part.parse::<std::net::IpAddr>().is_ok() {
                            ip = part.to_string();
                        } else {
                            hostname = part.to_string();
                        }
                    }
                    idx += 1;
                }

                if ip.is_empty() && !hostname.is_empty() { ip = hostname.clone(); }

                hops.push(TraceHop { ttl, ip, hostname, rtt_ms, location: String::new(), asn: String::new() });
            }

            let error = if hops.is_empty() && !stderr.is_empty() { stderr.trim().to_string() } else if hops.is_empty() { "traceroute 无输出".to_string() } else { String::new() };
            TraceResult { hops, maptrace_url: String::new(), error, duration_ms: start.elapsed().as_millis() as u64, target }
        }
        Err(e) => TraceResult { hops: vec![], maptrace_url: String::new(), error: format!("执行失败: {}", e), duration_ms: 0, target },
    }
}

// ========== Diagnosis ==========

#[derive(Serialize, Clone)]
pub struct CheckResult {
    pub name: String,
    pub status: String,
    pub value: String,
    pub detail: String,
}

#[derive(Serialize, Clone)]
pub struct AppLatency {
    pub name: String,
    pub latency_ms: i64,
    pub status: String,
}

#[derive(Serialize, Clone)]
pub struct IpConflict {
    pub ip: String,
    pub macs: Vec<String>,
}

#[derive(Serialize, Clone)]
pub struct RogueDevice {
    pub ip: String,
    pub mac: String,
    pub vendor: String,
    pub confidence: u8,
}

#[derive(Serialize, Clone)]
pub struct DiagResult {
    pub overall: String,
    pub checks: Vec<CheckResult>,
    pub app_latencies: Vec<AppLatency>,
    pub gateway_ping_ms: f64,
    pub gateway_loss: f64,
    pub external_ping_ms: f64,
    pub external_loss: f64,
    pub dns_ms: f64,
    pub ip_conflicts: Vec<IpConflict>,
    pub rogue_devices: Vec<RogueDevice>,
}

fn parse_ping(output: &str) -> (f64, f64) {
    let mut loss = 100.0f64;
    let mut avg = 0.0f64;

    for line in output.lines() {
        // "1 packets transmitted, 1 packets received, 0.0% packet loss"
        if line.contains("packet loss") {
            if let Some(pos) = line.find('%') {
                if let Some(num) = line[..pos].split_whitespace().last() {
                    loss = num.parse().unwrap_or(100.0);
                }
            }
        }
        // "round-trip min/avg/max/stddev = 1.234/1.234/1.234/0.000 ms"
        if line.contains("min/avg/max") {
            if let Some(stats) = line.split('=').nth(1) {
                if let Some(avg_str) = stats.split('/').nth(1) {
                    avg = avg_str.trim().parse().unwrap_or(0.0);
                }
            }
        }
    }

    // If 100% loss, avg should be 0
    if loss >= 100.0 {
        avg = 0.0;
    }

    (avg, loss)
}

fn ping(target: &str, count: u8) -> (f64, f64) {
    if target.is_empty() {
        return (0.0, 100.0);
    }
    let output = run_cmd("ping", &["-c", &count.to_string(), "-W", "2000", target]);
    parse_ping(&output)
}

fn parse_query_time(output: &str) -> Option<f64> {
    for line in output.lines() {
        if let Some(pos) = line.find("Query time:") {
            let rest = line[pos + "Query time:".len()..].trim();
            let n: String = rest.chars().take_while(|c| c.is_ascii_digit() || *c == '.').collect();
            if let Ok(v) = n.parse::<f64>() {
                return Some(v);
            }
        }
    }
    None
}

fn dns_resolve_time(server: &str) -> f64 {
    if server.is_empty() {
        return 9999.0;
    }
    let dig = run_cmd("dig", &["+time=2", "+tries=1", "+stats", "baidu.com", &format!("@{server}")]);
    if !dig.is_empty() {
        if let Some(ms) = parse_query_time(&dig) {
            return ms;
        }
        if dig.contains("timed out") || dig.contains("no servers could be reached") || dig.contains("connection refused") {
            return 9999.0;
        }
    }
    let start = std::time::Instant::now();
    let output = run_cmd("nslookup", &["baidu.com", server]);
    let elapsed = start.elapsed().as_millis() as f64;
    if output.contains("can't find") || output.contains("** server can't find") || output.is_empty() {
        9999.0
    } else {
        elapsed
    }
}

fn http_probe(url: &str) -> (i64, bool) {
    let output = run_cmd("curl", &[
        "-s", "-o", "/dev/null", "-w", "%{http_code} %{time_total}",
        "-L", "--max-time", "8", url,
    ]);
    let mut parts = output.split_whitespace();
    let code = parts.next().unwrap_or("");
    let secs: f64 = parts.next().unwrap_or("0").parse().unwrap_or(0.0);
    ((secs * 1000.0).round() as i64, code.starts_with('2'))
}

fn probe_baidu() -> (i64, bool, u32) {
    let output = run_cmd("curl", &[
        "-s", "-o", "/dev/null", "-w", "%{http_code} %{time_total} %{num_redirects}",
        "-L", "--max-time", "8", "https://www.baidu.com",
    ]);
    let mut parts = output.split_whitespace();
    let code = parts.next().unwrap_or("");
    let secs: f64 = parts.next().unwrap_or("0").parse().unwrap_or(0.0);
    let redirects: u32 = parts.next().unwrap_or("0").parse().unwrap_or(0);
    ((secs * 1000.0).round() as i64, code.starts_with('2'), redirects)
}

#[derive(Serialize, Clone)]
pub struct PingOnceResult {
    pub gateway_ms: f64,
    pub external_ms: f64,
    pub gateway_loss: f64,
    pub external_loss: f64,
}

#[tauri::command]
fn ping_once(gateway: String) -> PingOnceResult {
    // Single ping to gateway (1 packet, 500ms timeout)
    let gw_output = run_cmd("ping", &["-c", "1", "-W", "500", &gateway]);
    let (gw_avg, gw_loss) = parse_ping(&gw_output);

    // Single ping to external (1 packet, 1500ms timeout)
    let ext_output = run_cmd("ping", &["-c", "1", "-W", "1500", EXTERNAL_IP]);
    let (ext_avg, ext_loss) = parse_ping(&ext_output);

    PingOnceResult {
        gateway_ms: gw_avg,
        external_ms: ext_avg,
        gateway_loss: gw_loss,
        external_loss: ext_loss,
    }
}

#[tauri::command]
fn run_diagnosis(gateway: String, dns_server: String) -> DiagResult {
    let (iface, detected_gw) = get_primary_interface();
    let gw = if gateway.trim().is_empty() { detected_gw } else { gateway };
    let dns_server = if dns_server.trim().is_empty() { EXTERNAL_IP.to_string() } else { dns_server };
    let (ip, mask) = get_ip_and_mask(&iface);

    let gw_for_ping = gw.clone();
    let dns_for_lookup = dns_server.clone();
    let ((gw_avg, gw_loss), (ext_avg, ext_loss), dns_ms, baidu, arp, proxy) = std::thread::scope(|s| {
        let t_gw = s.spawn(|| ping(&gw_for_ping, 3));
        let t_ext = s.spawn(|| ping(EXTERNAL_IP, 3));
        let t_dns = s.spawn(|| dns_resolve_time(&dns_for_lookup));
        let t_http = s.spawn(probe_baidu);
        let t_arp = s.spawn(get_arp_table);
        let t_proxy = s.spawn(inspect_proxy);
        (
            t_gw.join().unwrap_or((0.0, 100.0)),
            t_ext.join().unwrap_or((0.0, 100.0)),
            t_dns.join().unwrap_or(9999.0),
            t_http.join().unwrap_or((0, false, 0)),
            t_arp.join().unwrap_or_default(),
            t_proxy.join().unwrap_or_default(),
        )
    });

    let (http_ms, http_ok, redirects) = baidu;
    let ip_conflicts = detect_ip_conflicts(&arp);
    let rogue_devices = detect_rogue_devices(&arp, &gw);

    let apps = [
        ("百度", "https://www.baidu.com"),
        ("淘宝", "https://www.taobao.com"),
        ("腾讯", "https://www.qq.com"),
        ("Google", "https://www.google.com"),
    ];
    let app_latencies: Vec<AppLatency> = std::thread::scope(|s| {
        let handles: Vec<_> = apps.into_iter().map(|(name, url)| {
            s.spawn(move || {
                let (ms, ok) = http_probe(url);
                let status = if !ok || ms <= 0 { "error" } else if ms > 800 { "warning" } else { "ok" };
                AppLatency {
                    name: name.to_string(),
                    latency_ms: if status == "error" { 0 } else { ms },
                    status: status.to_string(),
                }
            })
        }).collect();
        handles.into_iter().map(|h| h.join().unwrap()).collect()
    });

    let gw_status = if gw_loss > 50.0 || gw_avg <= 0.0 { "error" } else if gw_loss > 0.0 { "warning" } else { "ok" };
    let http_status = if !http_ok { "error" } else if http_ms > 800 { "warning" } else { "ok" };
    let dns_status = if dns_ms > 1000.0 { "error" } else if dns_ms > 200.0 { "warning" } else { "ok" };
    let ip_status = if ip.is_empty() || gw.is_empty() || mask.is_empty() { "error" } else { "ok" };
    let proxy_status = if proxy.enabled && !proxy.listening && is_loopback(proxy.address.split(':').next().unwrap_or("")) {
        "warning"
    } else {
        "ok"
    };
    let redir_status = if http_ok && redirects <= 5 { "ok" } else { "error" };

    let checks = vec![
        CheckResult {
            name: "网关连通".to_string(),
            status: gw_status.to_string(),
            value: if gw_avg > 0.0 { format!("{:.0}ms", gw_avg) } else { "超时".to_string() },
            detail: if gw_loss > 0.0 { format!("{gw} · 丢包 {gw_loss:.0}%") } else { gw.clone() },
        },
        CheckResult {
            name: "外网连通".to_string(),
            status: http_status.to_string(),
            value: if http_ok { format!("{http_ms}ms") } else { "失败".to_string() },
            detail: "https://www.baidu.com".to_string(),
        },
        CheckResult {
            name: "DNS 解析".to_string(),
            status: dns_status.to_string(),
            value: if dns_status == "ok" { "正常".to_string() } else { format!("{dns_ms:.0}ms") },
            detail: dns_server.clone(),
        },
        CheckResult {
            name: "IP 配置".to_string(),
            status: ip_status.to_string(),
            value: if ip_status == "ok" { "正常".to_string() } else { "异常".to_string() },
            detail: if ip.is_empty() { "未获取到 IP".to_string() } else { ip },
        },
        CheckResult {
            name: "代理服务".to_string(),
            status: proxy_status.to_string(),
            value: if proxy.enabled { "正常".to_string() } else { "未启用".to_string() },
            detail: if proxy.enabled { proxy.address.clone() } else { String::new() },
        },
        CheckResult {
            name: "网页重定向".to_string(),
            status: redir_status.to_string(),
            value: if redir_status == "ok" { "正常".to_string() } else { "异常".to_string() },
            detail: format!("重定向 {redirects} 次"),
        },
    ];

    let has_error = checks.iter().any(|c| c.status == "error") || !ip_conflicts.is_empty();
    let has_warning = checks.iter().any(|c| c.status == "warning")
        || rogue_devices.iter().any(|r| r.confidence >= 90);
    let overall = if has_error { "error" } else if has_warning { "warning" } else { "ok" };

    DiagResult {
        overall: overall.to_string(),
        checks,
        app_latencies,
        gateway_ping_ms: gw_avg,
        gateway_loss: gw_loss,
        external_ping_ms: ext_avg,
        external_loss: ext_loss,
        dns_ms,
        ip_conflicts,
        rogue_devices,
    }
}

#[derive(Serialize, Clone, Default)]
pub struct ExitInfo {
    pub ip: String,
    pub region: String,
    pub city: String,
    pub isp: String,
    pub overseas: bool,
}

#[derive(Serialize, Clone, Default)]
pub struct ProxyInsight {
    pub enabled: bool,
    pub mode: String,
    pub service: String,
    pub port: u16,
    pub address: String,
    pub kind: String,
    pub listening: bool,
    pub latency_ms: i64,
    pub process_name: String,
    pub connection_count: u32,
    pub proxy_exit: ExitInfo,
    pub direct_exit: ExitInfo,
}

#[derive(Clone, Default)]
struct ProxyFacts {
    enabled: bool,
    mode: String,
    service: String,
    port: u16,
    address: String,
    kind: String,
    listening: bool,
    process_name: String,
}

fn curl_cmd() -> Command {
    let mut cmd = Command::new("curl");
    for key in ["http_proxy", "https_proxy", "all_proxy", "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY"] {
        cmd.env_remove(key);
    }
    cmd
}

fn is_loopback(host: &str) -> bool {
    host == "127.0.0.1" || host == "localhost" || host == "::1"
}

fn pretty_proc(name: &str) -> String {
    let n = name.to_lowercase();
    if n.contains("mihomo") || n.contains("clash") || n.contains("verge") || n.contains("stash") {
        "Clash / Mihomo".to_string()
    } else if name.is_empty() {
        "本地代理".to_string()
    } else {
        name.to_string()
    }
}

fn port_listeners(port: u16) -> Vec<String> {
    let spec = format!("-iTCP:{port}");
    let out = run_cmd("lsof", &["-nP", "+c0", &spec, "-sTCP:LISTEN"]);
    out.lines()
        .skip(1)
        .filter_map(|line| {
            let name = line.split_whitespace().next().unwrap_or("");
            if name.is_empty() { None } else { Some(name.to_string()) }
        })
        .collect()
}

fn port_listening(port: u16) -> bool {
    !port_listeners(port).is_empty()
}

fn listener_name(port: u16) -> String {
    port_listeners(port).into_iter().next().unwrap_or_default()
}

fn find_local_proxy_port() -> Option<(u16, String)> {
    for port in [7897u16, 7890, 7893, 1080, 1087, 20171] {
        if let Some(name) = port_listeners(port).into_iter().next() {
            return Some((port, name));
        }
    }
    None
}

fn read_service_proxy(service: &str) -> Option<(String, u16, &'static str)> {
    for (flag, kind) in [("-getwebproxy", "http"), ("-getsecurewebproxy", "https"), ("-getsocksfirewallproxy", "socks")] {
        let out = run_cmd("networksetup", &[flag, service]);
        let mut enabled = false;
        let mut server = String::new();
        let mut port = 0u16;
        for line in out.lines() {
            let t = line.trim();
            if let Some(rest) = t.strip_prefix("Enabled:") {
                let v = rest.trim().to_lowercase();
                enabled = v.contains("yes") || v == "on";
            } else if let Some(rest) = t.strip_prefix("Server:") {
                server = rest.trim().to_string();
            } else if let Some(rest) = t.strip_prefix("Port:") {
                port = rest.trim().parse().unwrap_or(0);
            }
        }
        if enabled && !server.is_empty() && server != "(null)" && port > 0 {
            return Some((server, port, kind));
        }
    }
    None
}

fn system_proxy(service: &str) -> Option<(String, u16, &'static str)> {
    let mut names: Vec<&str> = Vec::new();
    if !service.is_empty() {
        names.push(service);
    }
    if service != "Wi-Fi" {
        names.push("Wi-Fi");
    }
    if service != "Ethernet" {
        names.push("Ethernet");
    }
    for name in names {
        if let Some(found) = read_service_proxy(name) {
            return Some(found);
        }
    }
    None
}

fn clash_mode() -> Option<String> {
    let texts: Vec<String> = std::thread::scope(|s| {
        let handles: Vec<_> = [9090u16, 9097].into_iter().map(|port| {
            s.spawn(move || {
                let mut cmd = curl_cmd();
                let url = format!("http://127.0.0.1:{port}/configs");
                cmd.args(["-s", "--max-time", "1", "--noproxy", "*", &url]);
                cmd.output().ok().map(|o| String::from_utf8_lossy(&o.stdout).to_string()).unwrap_or_default()
            })
        }).collect();
        handles.into_iter().map(|h| h.join().unwrap_or_default()).collect()
    });
    for text in texts {
        let Ok(v) = serde_json::from_str::<serde_json::Value>(text.trim()) else { continue };
        let label = match v.get("mode").and_then(|m| m.as_str()).unwrap_or("") {
            "rule" => "规则模式",
            "global" => "全局模式",
            "direct" => "直连模式",
            _ => continue,
        };
        return Some(label.to_string());
    }
    None
}

fn inspect_proxy() -> ProxyFacts {
    let (iface, _) = get_primary_interface();
    let service_name = hardware_port_for(&iface);

    let (host, port, kind, from_system, process) = if let Some((host, port, kind)) = system_proxy(&service_name) {
        let process = if is_loopback(&host) { listener_name(port) } else { String::new() };
        (host, port, kind.to_string(), true, process)
    } else if let Some((port, name)) = find_local_proxy_port() {
        ("127.0.0.1".to_string(), port, "http".to_string(), false, name)
    } else {
        return ProxyFacts { mode: "未启用".into(), ..ProxyFacts::default() };
    };

    let listening = if is_loopback(&host) { port_listening(port) } else { true };
    let mode = clash_mode().unwrap_or_else(|| if from_system { "系统代理".into() } else { "本地端口".into() });

    ProxyFacts {
        enabled: true,
        mode,
        service: pretty_proc(if process.is_empty() { "本地代理" } else { &process }),
        port,
        address: format!("{host}:{port}"),
        kind,
        listening,
        process_name: process,
    }
}

fn format_region(code: &str, country: &str) -> String {
    if code.is_empty() { return country.to_string(); }
    if country.is_empty() { return code.to_string(); }
    format!("{code}（{country}）")
}

fn parse_exit(text: &str) -> ExitInfo {
    let Ok(v) = serde_json::from_str::<serde_json::Value>(text.trim()) else {
        return ExitInfo::default();
    };
    if v.get("status").and_then(|s| s.as_str()) != Some("success") {
        return ExitInfo::default();
    }
    let code = v.get("countryCode").and_then(|s| s.as_str()).unwrap_or("");
    let country = v.get("country").and_then(|s| s.as_str()).unwrap_or("");
    let city = v.get("city").and_then(|s| s.as_str()).unwrap_or("");
    let region_name = v.get("regionName").and_then(|s| s.as_str()).unwrap_or("");
    let city_line = if !city.is_empty() && !region_name.is_empty() && city != region_name {
        format!("{region_name} · {city}")
    } else if !city.is_empty() {
        city.to_string()
    } else {
        region_name.to_string()
    };
    ExitInfo {
        ip: v.get("query").and_then(|s| s.as_str()).unwrap_or("").to_string(),
        region: format_region(code, country),
        city: city_line,
        isp: v.get("isp").and_then(|s| s.as_str()).unwrap_or("").to_string(),
        overseas: !code.is_empty() && code != "CN",
    }
}

fn lookup_exit(proxy: Option<&str>) -> ExitInfo {
    let mut cmd = curl_cmd();
    cmd.args(["-s", "--max-time", "4"]);
    if let Some(p) = proxy {
        cmd.args(["-x", p]);
    } else {
        cmd.args(["--noproxy", "*"]);
    }
    cmd.arg("http://ip-api.com/json/?lang=zh-CN&fields=status,country,countryCode,regionName,city,isp,query");
    let output = cmd.output().ok().map(|o| String::from_utf8_lossy(&o.stdout).to_string()).unwrap_or_default();
    parse_exit(&output)
}

fn proxy_url(kind: &str, address: &str) -> String {
    if kind == "socks" {
        format!("socks5h://{address}")
    } else {
        format!("http://{address}")
    }
}

fn local_connect_ms(address: &str) -> i64 {
    if address.is_empty() {
        return 0;
    }
    let mut cmd = curl_cmd();
    let url = format!("http://{address}");
    cmd.args(["-s", "-o", "/dev/null", "-w", "%{time_connect}", "--max-time", "2", "--noproxy", "*", &url]);
    let output = cmd.output().ok().map(|o| String::from_utf8_lossy(&o.stdout).to_string()).unwrap_or_default();
    let secs: f64 = output.trim().parse().unwrap_or(0.0);
    (secs * 1000.0).round() as i64
}

fn proxy_clients(port: u16) -> (String, u32) {
    let spec = format!("-iTCP:{port}");
    let out = run_cmd("lsof", &["-nP", "+c0", &spec, "-sTCP:ESTABLISHED"]);
    let mut counts: std::collections::HashMap<String, u32> = std::collections::HashMap::new();
    for line in out.lines().skip(1) {
        let name = line.split_whitespace().next().unwrap_or("");
        if name.is_empty() { continue; }
        *counts.entry(name.to_string()).or_default() += 1;
    }
    let total: u32 = counts.values().copied().sum();
    let top = counts.into_iter().max_by_key(|(_, c)| *c).map(|(n, _)| n).unwrap_or_default();
    (top, total)
}

#[tauri::command]
fn get_proxy_insight() -> ProxyInsight {
    let facts = inspect_proxy();
    if !facts.enabled {
        return ProxyInsight { mode: "未启用".into(), ..ProxyInsight::default() };
    }

    let proxy_arg = proxy_url(&facts.kind, &facts.address);
    let address = facts.address.clone();
    let port = facts.port;
    let (latency, clients, proxy_exit, direct_exit) = std::thread::scope(|s| {
        let t_lat = s.spawn(move || local_connect_ms(&address));
        let t_clients = s.spawn(move || if port > 0 { proxy_clients(port) } else { (String::new(), 0) });
        let t_proxy = s.spawn(move || lookup_exit(Some(&proxy_arg)));
        let t_direct = s.spawn(|| lookup_exit(None));
        (
            t_lat.join().unwrap_or(0),
            t_clients.join().unwrap_or_default(),
            t_proxy.join().unwrap_or_default(),
            t_direct.join().unwrap_or_default(),
        )
    });
    let (proc, count) = clients;

    ProxyInsight {
        enabled: true,
        mode: facts.mode,
        service: facts.service,
        port: facts.port,
        address: facts.address,
        kind: facts.kind,
        listening: facts.listening,
        latency_ms: latency,
        process_name: if proc.is_empty() { facts.process_name } else { proc },
        connection_count: count,
        proxy_exit,
        direct_exit,
    }
}

#[tauri::command]
fn open_url(url: String) -> Result<(), String> {
    const ALLOWED: &[&str] = &[
        "https://www.speedtest.net/",
        "https://www.speedtest.net",
        "https://speedtest.net/",
        "https://test.ustc.edu.cn/",
        "https://test.ustc.edu.cn",
    ];
    if !ALLOWED.contains(&url.as_str()) {
        return Err("不支持打开这个地址".into());
    }
    Command::new("open").arg(&url).spawn().map_err(|e| e.to_string())?;
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![get_network_info, run_diagnosis, ping_once, trace_route, get_proxy_insight, open_url])
        .run(tauri::generate_context!())
        .expect("error while building tauri application");
}
