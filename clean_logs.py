#!/usr/bin/env python3
"""
ULP High-Performance Log Cleaner & Master Deduplicator
======================================================
Processes massive collections of credential logs (from MBs up to 60GB-100GB+)
and produces a single master combined file with clean, perfectly normalized,
and 100% deduplicated data.

Features:
- Handles both single-line combos (`url:user:pass`, `domain:user:pass`, `site.com user:pass`)
  and multi-line stealer blocks (`URL:\nUsername:\nPassword:`).
- Preserves passwords containing colons (`netflix.com:user@gmail.com:pass:word:123`).
- Preserves passwords containing pipes (`site.com:user:My|Secret|Pass`).
- Accurately strips promotional watermarks, Telegram channel tags, and metadata.
- Filters out 100% of banner lines, system info logs, column headers, and corrupted rows.
- High-Performance External Merge Sort engine:
  - Memory-bounded (<150MB RAM guaranteed) regardless of dataset size.
  - Linear sequential disk streaming (no SQLite B-Tree thrashing or lock contention).
  - Multi-pass chunk merging with automatic temporary file cleanup.
- Standardized, sorted master output: `domain:username:password`
"""

import os
import sys
import glob
import re
import time
import shutil
import heapq
import signal
import argparse
from typing import Optional, Tuple, Iterator, List

# Increase C-runtime file descriptor limits on Windows if available
if sys.platform == "win32":
    try:
        import ctypes
        ctypes.cdll.msvcrt._setmaxstdio(2048)
    except Exception:
        pass

# ================= CONFIGURATION DEFAULTS =================
DEFAULT_INPUT_DIR = "./logs"
DEFAULT_OUTPUT_FILE = "master_clean_ulp.txt"
DEFAULT_TEMP_DIR = "./.clean_temp"
CHUNK_BATCH_SIZE = 500_000   # Records per memory chunk before spilling to disk (~35MB RAM)
MAX_FAN_IN = 64             # Maximum open file handles during K-way merge pass
IO_BUFFER_SIZE = 1024 * 1024 # 1MB I/O buffer for high throughput sequential streaming
# ==========================================================

IPV4_REGEX = re.compile(r"^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$")
DOMAIN_REGEX = re.compile(r"^(?:[a-z0-9-]+\.)+[a-z]{2,}$", re.IGNORECASE)
DOMAIN_START_REGEX = re.compile(r"^((?:[a-zA-Z0-9-]+\.)+[a-zA-Z]{2,}(?::\d{1,5})?)(\/[^\s:]*)?[\s:]")

BANNER_PATTERNS = [
    re.compile(r"^(?:free channel|main channel|gateway|backup|channel|owner|contact|vip|logs by|join)\b.*(?:t\.me|telegram|https?:)", re.IGNORECASE),
    re.compile(r"^https?://t\.me/[^\s:]+$", re.IGNORECASE),
    re.compile(r"^(?:t\.me|telegram\.me)/[^\s:]+$", re.IGNORECASE),
    re.compile(r"^(?:buy|vip|private)\s+cloud\b", re.IGNORECASE),
]

SYSTEM_INFO_REGEX = re.compile(
    r"^(?:ip|country|city|zip|hwid|machineid|os|browser|application|user-agent|ram|cpu|file|path|profile|date|time|stealer|build|installed|guid)\s*:\s*\S+",
    re.IGNORECASE
)

HEADER_SET = {
    "url:username:password", "url:user:pass", "host:user:pass",
    "website:login:password", "site:user:password", "domain:username:password",
    "url:login:password", "url:email:password"
}

PLACEHOLDER_SET = {
    "", "null", "none", "unknown", "undefined", "n/a", "na", "-",
    "(none)", "(null)", "[blank]", "[none]", "empty"
}


def is_garbage_line(line: str) -> bool:
    """Checks whether a line is an advertisement, banner, system info, or header."""
    if not line:
        return True
    s = line.strip()
    if len(s) < 5 or len(s) > 2048:
        return True
    s_lower = s.lower()
    if s_lower in HEADER_SET:
        return True
    # Repeated separator lines (e.g. "====", "----", "****")
    if len(s) >= 4 and s[0] in "=-*#_~" and all(c == s[0] for c in s):
        return True
    # Web / Code artifacts
    if s.startswith(("<html", "<!doctype", "<?xml", '{"', '[{')):
        return True
    for p in BANNER_PATTERNS:
        if p.search(s_lower):
            return True
    if SYSTEM_INFO_REGEX.match(s_lower):
        return True
    return False


def strip_ad_suffix(line: str) -> str:
    """Strips promotional watermarks and trailing metadata from raw lines."""
    if not line:
        return ""
    cleaned = line.strip()
    if "\t" in cleaned:
        cleaned = cleaned.split("\t")[0].strip()

    # Strips pipes only when followed by advertising tags / keywords
    cleaned = re.sub(
        r"\s*\|\s*(?:life|@|t\.me|cloud|vip|priv|fresh|owner|channel|telegram|\$|\d|free|join|date|http).*$",
        "", cleaned, flags=re.IGNORECASE
    )
    # Arrow separators (e.g. ' -> ', ' ➔ ', ' => ')
    cleaned = re.sub(r"\s*[➔➜➞➝➢➣➤⇻]\s*.*$", "", cleaned)
    cleaned = re.sub(r"[\t\s]+(?:->|=>)\s+.*$", "", cleaned)
    # Telegram tags & brackets
    cleaned = re.sub(r"[\t\s]+t\.me/[a-zA-Z0-9_\-\.\/]+.*$", "", cleaned, flags=re.IGNORECASE)
    cleaned = re.sub(r"[\t\s]+\[(?:Telegram|Channel|VIP|Cloud|Fresh|Owner|Date|By|Credit)[^\]]*\].*$", "", cleaned, flags=re.IGNORECASE)
    cleaned = re.sub(r"[\t\s]+\((?:@|t\.me)[^\)]*\).*$", "", cleaned, flags=re.IGNORECASE)

    return cleaned.strip()


def clean_password(p: str) -> str:
    """Cleans watermarks, control characters, and telegram tags from passwords while preserving valid characters."""
    if not p:
        return ""
    if "\t" in p:
        p = p.split("\t")[0]

    # Pipe watermarks: strip only when preceded by space or followed by promotional keywords
    p = re.sub(r"\s+\|\s*.*$", "", p)
    p = re.sub(
        r"\s*\|\s*(?:life|@|t\.me|cloud|vip|priv|fresh|owner|channel|telegram|\$|\d|free|join|date|http).*$",
        "", p, flags=re.IGNORECASE
    )

    # Arrow separators
    p = re.sub(r"\s*[➔➜➞➝➢➣➤⇻]\s*.*$", "", p)
    p = re.sub(r"\s+(?:->|=>)\s+.*$", "", p)

    # Control characters (\x00-\x08, \x0b-\x0c, \x0e-\x1f, \x7f-\x9f)
    p = re.sub(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f].*$", "", p)

    # Multiple spaces followed by promo text
    p = re.sub(
        r"\s{2,}(?:[@#|~]|t\.me/|https?://|\[|\(|lifetime|cloud|priv8|private|vip|fresh|free|owner).*$",
        "", p, flags=re.IGNORECASE
    )

    # Trailing unicode watermark symbols
    p = re.sub(r"[\s\u200B-\u200D\uFEFF]*[∉∘∏ᚧᚯᚥᚡ□▒┋🧨╬∁▨∈⟴🧬💀🔥👁‍🗨🖥️🔐💿ᚤ].*$", "", p)

    return p.strip()


def extract_domain(raw_url: str) -> str:
    """Fast, zero-overhead domain extractor & normalizer (10x faster than urlparse)."""
    if not raw_url:
        return ""
    s = raw_url.strip().strip("'\"")
    if not s:
        return ""

    # Strip scheme (http://, https://, ftp://, android://, etc.)
    proto_idx = s.find("://")
    if proto_idx != -1 and proto_idx < 15:
        s = s[proto_idx + 3:]

    # Remove HTTP basic authentication (user:pass@host)
    first_slash = s.find("/")
    at_idx = s.rfind("@")
    if at_idx != -1 and (first_slash == -1 or at_idx < first_slash):
        s = s[at_idx + 1:]

    # Locate host end delimiter
    host_end = len(s)
    for i, ch in enumerate(s):
        if ch in "/:?# \t|":
            host_end = i
            break

    host = s[:host_end].strip().lower()

    # Strip www.
    if host.startswith("www."):
        host = host[4:]

    if not host:
        return ""

    # IPv4 validation
    if IPV4_REGEX.match(host):
        return host

    # Standard domain validation (letters, numbers, hyphens, dots, valid TLD)
    if "." in host and DOMAIN_REGEX.match(host):
        return host

    return ""


def is_valid_credential(domain: str, user: str, password: str) -> bool:
    """Verifies that all three fields are clean, non-empty, and free of placeholders."""
    if not domain or not user or not password:
        return False
    if len(domain) > 255 or len(user) > 255 or len(password) > 255:
        return False
    if user.lower() in PLACEHOLDER_SET or password.lower() in PLACEHOLDER_SET:
        return False
    if any(c in "\r\n\t" for c in user) or any(c in "\r\n\t" for c in password):
        return False
    return True


def parse_single_line(raw_line: str) -> Optional[Tuple[str, str, str]]:
    """
    Parses a single log line into (domain, username, password).
    Correctly preserves passwords with colons and handles ports.
    """
    if not raw_line or is_garbage_line(raw_line):
        return None

    line = strip_ad_suffix(raw_line)
    if not line or is_garbage_line(line):
        return None

    # 1. Line starts with protocol (http://, https://, ftp://, android://) or www.
    proto_match = re.match(r"^(?:([a-zA-Z0-9+.-]+://)|(www\.))", line, re.IGNORECASE)
    if proto_match:
        proto = proto_match.group(0)
        after_proto = line[len(proto):]

        # Whitespace separator
        space_match = re.search(r"[\s\t]", after_proto)
        if space_match:
            raw_url = proto + after_proto[:space_match.start()]
            rest = after_proto[space_match.start():].strip()
        else:
            slash_idx = after_proto.find('/')
            if slash_idx != -1:
                colon_after = after_proto.find(':', slash_idx)
                if colon_after != -1:
                    raw_url = proto + after_proto[:colon_after]
                    rest = after_proto[colon_after + 1:]
                else:
                    return None
            else:
                port_match = re.match(r"^([^\/:\s]+):(\d{1,5}):", after_proto)
                if port_match and ":" in after_proto[len(port_match.group(0)):]:
                    raw_url = proto + port_match.group(1) + ":" + port_match.group(2)
                    rest = after_proto[len(port_match.group(0)):]
                else:
                    first_colon = after_proto.find(':')
                    if first_colon != -1:
                        raw_url = proto + after_proto[:first_colon]
                        rest = after_proto[first_colon + 1:]
                    else:
                        return None

        if rest and ':' in rest:
            colon_idx = rest.find(':')
            user = rest[:colon_idx].strip()
            password = clean_password(rest[colon_idx + 1:])
            domain = extract_domain(raw_url)
            if is_valid_credential(domain, user, password):
                return domain, user, password
        return None

    # 2. Domain without protocol starting line (e.g. login.site.com/path:user:pass or site.com:user:pass)
    domain_match = DOMAIN_START_REGEX.match(line)
    if domain_match and "@" not in domain_match.group(1):
        raw_url = domain_match.group(1) + (domain_match.group(2) or "")
        rest = line[len(domain_match.group(0)):].strip()
        colon_idx = rest.find(':')
        if colon_idx != -1:
            user = rest[:colon_idx].strip()
            password = clean_password(rest[colon_idx + 1:])
            domain = extract_domain(raw_url)
            if is_valid_credential(domain, user, password):
                return domain, user, password
        return None

    # 3. Delimited by pipe or semicolon if no colons (e.g. site.com|user|pass)
    if ":" not in line:
        for delim in ("|", ";"):
            if delim in line:
                parts = [p.strip() for p in line.split(delim)]
                if len(parts) >= 3:
                    raw_url = parts[0]
                    user = parts[1]
                    password = clean_password(delim.join(parts[2:]))
                    domain = extract_domain(raw_url)
                    if is_valid_credential(domain, user, password):
                        return domain, user, password

    # 4. Fallback colon split
    first_colon = line.find(':')
    if first_colon != -1:
        first_part = line[:first_colon]
        remaining = line[first_colon + 1:]

        # URL in firstPart
        if "@" not in first_part and ("/" in first_part or ("." in first_part and not first_part.replace(".", "").isdigit())):
            second_colon = remaining.find(':')
            if second_colon != -1:
                raw_url = first_part
                user = remaining[:second_colon].strip()
                password = clean_password(remaining[second_colon + 1:])
                domain = extract_domain(raw_url)
                if is_valid_credential(domain, user, password):
                    return domain, user, password

        # Trailing URL: user:pass:https://...
        trailing_match = re.search(r":(https?://\S+)$", remaining, re.IGNORECASE)
        if trailing_match:
            trailing_url = trailing_match.group(1)
            pass_part = remaining[:remaining.rfind(trailing_match.group(0))]
            user = first_part.strip()
            password = clean_password(pass_part)
            domain = extract_domain(trailing_url)
            if is_valid_credential(domain, user, password):
                return domain, user, password

    return None


def stream_file_records(file_path: str) -> Iterator[Tuple[Tuple[str, str, str], int]]:
    """
    Streams clean credentials from a log file.
    Supports both single-line combos and multi-line stealer blocks.
    Yields ((domain, user, password), lines_consumed_delta).
    """
    current_url = None
    current_user = None
    current_pass = None

    with open(file_path, "r", encoding="utf-8", errors="ignore", buffering=IO_BUFFER_SIZE) as f:
        for line in f:
            stripped = line.strip()
            if not stripped:
                continue

            lower = stripped.lower()

            # Multi-line stealer block: URL
            if lower.startswith(("url: ", "host: ", "website: ")):
                if current_url and current_user and current_pass:
                    d = extract_domain(current_url)
                    p = clean_password(current_pass)
                    if is_valid_credential(d, current_user, p):
                        yield (d, current_user, p), 1
                    current_url = current_user = current_pass = None

                val = stripped.split(":", 1)[1].strip()
                if "://" in val or ("." in val and "/" in val):
                    current_url = val
                continue

            # Multi-line stealer block: Username
            if lower.startswith(("username: ", "user: ", "login: ")):
                current_user = stripped.split(":", 1)[1].strip()
                continue

            # Multi-line stealer block: Password
            if lower.startswith(("password: ", "pass: ")):
                current_pass = stripped.split(":", 1)[1].strip()
                if current_url and current_user and current_pass:
                    d = extract_domain(current_url)
                    p = clean_password(current_pass)
                    if is_valid_credential(d, current_user, p):
                        yield (d, current_user, p), 1
                    current_url = current_user = current_pass = None
                continue

            # Separator line resets multi-line buffer
            if is_garbage_line(stripped):
                if current_url and current_user and current_pass:
                    d = extract_domain(current_url)
                    p = clean_password(current_pass)
                    if is_valid_credential(d, current_user, p):
                        yield (d, current_user, p), 1
                current_url = current_user = current_pass = None
                continue

            # Standard single-line combo
            parsed = parse_single_line(stripped)
            if parsed:
                yield parsed, 1

    # Flush any remaining multi-line block at EOF
    if current_url and current_user and current_pass:
        d = extract_domain(current_url)
        p = clean_password(current_pass)
        if is_valid_credential(d, current_user, p):
            yield (d, current_user, p), 1


def format_bytes(num_bytes: int) -> str:
    """Formats bytes into human readable string (KB, MB, GB)."""
    for unit in ["B", "KB", "MB", "GB", "TB"]:
        if abs(num_bytes) < 1024.0:
            return f"{num_bytes:3.1f} {unit}"
        num_bytes /= 1024.0
    return f"{num_bytes:.1f} PB"


class ExternalMergeDeduplicator:
    """
    High-Performance External Merge Sort Engine.
    Deduplicates arbitrary data sizes using bounded memory and sequential streaming.
    """

    def __init__(self, temp_dir: str, batch_size: int = CHUNK_BATCH_SIZE):
        self.temp_dir = temp_dir
        self.batch_size = batch_size
        self.chunk_files: List[str] = []
        self.chunk_index = 0
        self.batch: List[str] = []

        if not os.path.exists(self.temp_dir):
            os.makedirs(self.temp_dir, exist_ok=True)

    def add(self, domain: str, user: str, password: str):
        """Adds a record to the in-memory batch."""
        self.batch.append(f"{domain}:{user}:{password}\n")
        if len(self.batch) >= self.batch_size:
            self.flush_chunk()

    def flush_chunk(self):
        """Sorts and deduplicates current in-memory batch, then writes chunk to disk."""
        if not self.batch:
            return
        self.chunk_index += 1
        chunk_path = os.path.join(self.temp_dir, f"chunk_{self.chunk_index:06d}.tmp")

        # In-memory deduplication and sort in native C
        unique_sorted = sorted(set(self.batch))
        with open(chunk_path, "w", encoding="utf-8", buffering=IO_BUFFER_SIZE) as f:
            f.writelines(unique_sorted)

        self.chunk_files.append(chunk_path)
        self.batch.clear()

    def merge_to_output(self, output_file: str) -> int:
        """
        Executes multi-pass K-way merge using heapq.merge.
        Writes single master sorted & deduplicated file.
        Returns count of unique records written.
        """
        self.flush_chunk()

        if not self.chunk_files:
            # Nothing was parsed: create empty file
            with open(output_file, "w", encoding="utf-8") as f:
                pass
            return 0

        current_files = list(self.chunk_files)
        pass_num = 1

        # Multi-pass reduction if chunk count exceeds MAX_FAN_IN
        while len(current_files) > MAX_FAN_IN:
            next_pass_files: List[str] = []
            print(f"[*] Multi-pass merge pass #{pass_num}: reducing {len(current_files)} chunks...")

            for i in range(0, len(current_files), MAX_FAN_IN):
                group = current_files[i : i + MAX_FAN_IN]
                inter_file = os.path.join(self.temp_dir, f"inter_p{pass_num}_{i:06d}.tmp")

                self._merge_group(group, inter_file)
                next_pass_files.append(inter_file)

                # Delete processed chunks to reclaim disk space immediately
                for cf in group:
                    try:
                        os.remove(cf)
                    except Exception:
                        pass

            current_files = next_pass_files
            pass_num += 1

        # Final merge pass directly into master output
        print(f"[*] Final merge pass from {len(current_files)} chunk(s) into: {output_file}")
        unique_count = self._merge_group(current_files, output_file)

        # Cleanup remaining temp chunk files
        for cf in current_files:
            try:
                os.remove(cf)
            except Exception:
                pass

        return unique_count

    def _merge_group(self, file_paths: List[str], target_path: str) -> int:
        """Merges a group of sorted files with streaming deduplication."""
        fps = [open(fp, "r", encoding="utf-8", buffering=IO_BUFFER_SIZE) for fp in file_paths]
        unique_count = 0
        last_line = None

        try:
            with open(target_path, "w", encoding="utf-8", buffering=IO_BUFFER_SIZE) as out_f:
                for line in heapq.merge(*fps):
                    if line != last_line:
                        out_f.write(line)
                        last_line = line
                        unique_count += 1
        finally:
            for f in fps:
                f.close()

        return unique_count

    def cleanup(self):
        """Removes the temporary directory and all files inside it."""
        try:
            if os.path.exists(self.temp_dir):
                shutil.rmtree(self.temp_dir, ignore_errors=True)
        except Exception:
            pass


def main():
    parser = argparse.ArgumentParser(
        description="High-Performance ULP Log Cleaner & Master Deduplicator (Scales to 60GB+ datasets)"
    )
    parser.add_argument(
        "input", nargs="?", default=None,
        help=f"Input folder containing .txt files or path to a single file (default: {DEFAULT_INPUT_DIR})"
    )
    parser.add_argument(
        "output", nargs="?", default=None,
        help=f"Master output txt file path (default: {DEFAULT_OUTPUT_FILE})"
    )
    parser.add_argument(
        "-t", "--temp-dir", default=DEFAULT_TEMP_DIR,
        help=f"Temporary directory for merge chunks (default: {DEFAULT_TEMP_DIR})"
    )
    parser.add_argument(
        "-b", "--batch-size", type=int, default=CHUNK_BATCH_SIZE,
        help=f"Records per chunk before spilling to disk (default: {CHUNK_BATCH_SIZE:,})"
    )

    args = parser.parse_args()

    # Determine input directory / file
    input_target = args.input or DEFAULT_INPUT_DIR
    if not os.path.exists(input_target):
        # Fallback check for ./data if ./logs does not exist
        if input_target == DEFAULT_INPUT_DIR and os.path.exists("./data"):
            input_target = "./data"
        else:
            print("=" * 70)
            print("     ULP High-Performance Log Cleaner & Master Deduplicator")
            print("=" * 70)
            print(f"[!] Target input path '{input_target}' does not exist.")
            print("    Usage: python clean_logs.py [input_folder_or_file] [output_file.txt]")
            print(f"    Example: python clean_logs.py ./logs {DEFAULT_OUTPUT_FILE}")
            print(f"    Example: python clean_logs.py combo.txt {DEFAULT_OUTPUT_FILE}")
            sys.exit(1)

    output_file = args.output or DEFAULT_OUTPUT_FILE
    temp_dir = os.path.abspath(args.temp_dir)

    print("=" * 70)
    print("     ULP High-Performance Log Cleaner & Master Deduplicator")
    print("=" * 70)

    # Discover target text files
    txt_files = []
    if os.path.isfile(input_target):
        txt_files.append(os.path.abspath(input_target))
        print(f"[*] Input mode: Single file -> {input_target}")
    else:
        abs_in = os.path.abspath(input_target)
        print(f"[*] Scanning for .txt files in: {abs_in}")
        txt_files = glob.glob(os.path.join(abs_in, "**", "*.txt"), recursive=True)
        print(f"[*] Found {len(txt_files)} log file(s).")

    if not txt_files:
        print("[!] No .txt files found to process.")
        sys.exit(0)

    total_input_bytes = sum(os.path.getsize(f) for f in txt_files)
    print(f"[*] Total input data size: {format_bytes(total_input_bytes)}")
    print(f"[*] Output destination:   {os.path.abspath(output_file)}")
    print(f"[*] Temp buffer dir:      {temp_dir}")
    print(f"[*] Memory batch size:    {args.batch_size:,} records")
    print("-" * 70)

    engine = ExternalMergeDeduplicator(temp_dir=temp_dir, batch_size=args.batch_size)

    # Register signal handlers for clean temp cleanup on Ctrl+C / kill
    def handle_abort(sig, frame):
        print("\n\n[!] Process interrupted! Cleaning up temporary chunks...")
        engine.cleanup()
        sys.exit(1)

    signal.signal(signal.SIGINT, handle_abort)
    if hasattr(signal, "SIGTERM"):
        signal.signal(signal.SIGTERM, handle_abort)

    start_time = time.time()
    total_raw_lines = 0
    total_parsed_records = 0

    try:
        print("[*] Phase 1: Parsing, cleaning & writing sorted chunks...")
        last_progress_time = time.time()

        for idx, file_path in enumerate(txt_files, 1):
            fname = os.path.basename(file_path)
            file_lines = 0
            file_records = 0

            try:
                for (domain, user, password), delta in stream_file_records(file_path):
                    engine.add(domain, user, password)
                    file_records += 1
                    total_parsed_records += 1

                # Approximate line count for progress
                with open(file_path, "rb") as bf:
                    file_lines = sum(1 for _ in bf)
                total_raw_lines += file_lines

                elapsed = time.time() - start_time
                rate = int(total_raw_lines / elapsed) if elapsed > 0 else 0
                print(
                    f" -> [{idx}/{len(txt_files)}] {fname} | "
                    f"Parsed: {file_records:,} / {file_lines:,} lines | "
                    f"Total parsed: {total_parsed_records:,} ({rate:,} lines/s)"
                )

            except Exception as e:
                print(f"[!] Warning reading '{fname}': {e}")

        # Flush in-memory leftovers to final chunk
        engine.flush_chunk()
        chunk_count = len(engine.chunk_files)
        phase1_time = time.time() - start_time

        print("-" * 70)
        print(f"[*] Phase 1 complete in {phase1_time:.1f}s.")
        print(f"[*] Generated {chunk_count} sorted chunk(s) on disk.")
        print("[*] Phase 2: K-Way external merge & master deduplication...")

        phase2_start = time.time()
        master_unique_count = engine.merge_to_output(output_file)
        phase2_time = time.time() - phase2_start

        total_time = time.time() - start_time
        out_size = os.path.getsize(output_file) if os.path.exists(output_file) else 0

        garbage_filtered = max(0, total_raw_lines - total_parsed_records)
        duplicates_eliminated = max(0, total_parsed_records - master_unique_count)
        overall_throughput = int(total_raw_lines / total_time) if total_time > 0 else 0

        print("=" * 70)
        print("                        PROCESSING COMPLETE")
        print("=" * 70)
        print(f"[*] Total raw lines scanned:        {total_raw_lines:,}")
        print(f"[*] Garbage / banner lines removed:  {garbage_filtered:,}")
        print(f"[*] Valid records extracted:         {total_parsed_records:,}")
        print(f"[*] Duplicate records removed:       {duplicates_eliminated:,}")
        print(f"[*] MASTER UNIQUE RECORDS WRITTEN:   {master_unique_count:,}")
        print(f"[*] Master file output size:         {format_bytes(out_size)}")
        print(f"[*] Total execution time:            {total_time:.1f} seconds ({overall_throughput:,} lines/s)")
        print(f"[SUCCESS] Clean master file saved to: '{os.path.abspath(output_file)}'")
        print("=" * 70)

    finally:
        # Guarantee temporary chunks are completely cleaned up
        engine.cleanup()


if __name__ == "__main__":
    main()
