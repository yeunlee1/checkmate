// Squirrel의 ZIP 생성 결과에 한글 원본 이름과 NuGet 호환 이름을 함께 기록한다.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Reflection;
using System.Text;

internal static class ZipLauncher
{
    private sealed class Entry
    {
        internal byte[] Header;
        internal byte[] Name;
        internal byte[] Extra;
        internal byte[] Comment;
        internal byte[] Alias;
        internal byte[] UnicodeExtra;
        internal long Offset;
        internal long NewOffset;
    }

    private static readonly Encoding Utf8 = new UTF8Encoding(false, true);

    private static string Quote(string value)
    {
        var result = new StringBuilder("\"");
        int slashes = 0;
        foreach (char letter in value) {
            if (letter == '\\') { slashes++; continue; }
            if (letter == '"') { result.Append('\\', slashes * 2 + 1); result.Append('"'); slashes = 0; continue; }
            result.Append('\\', slashes); slashes = 0; result.Append(letter);
        }
        result.Append('\\', slashes * 2);
        return result.Append('"').ToString();
    }

    private static byte[] ReadBytes(BinaryReader reader, int count)
    {
        byte[] bytes = reader.ReadBytes(count);
        if (bytes.Length != count) throw new InvalidDataException("ZIP 항목이 잘렸습니다.");
        return bytes;
    }

    private static ushort U16(byte[] bytes, int at) { return BitConverter.ToUInt16(bytes, at); }
    private static uint U32(byte[] bytes, int at) { return BitConverter.ToUInt32(bytes, at); }
    private static void Put16(byte[] bytes, int at, ushort value) { Buffer.BlockCopy(BitConverter.GetBytes(value), 0, bytes, at, 2); }
    private static void Put32(byte[] bytes, int at, uint value) { Buffer.BlockCopy(BitConverter.GetBytes(value), 0, bytes, at, 4); }

    private static byte[] WithoutUnicodeExtra(byte[] extra)
    {
        using (var output = new MemoryStream()) {
            for (int at = 0; at < extra.Length;) {
                if (at + 4 > extra.Length) throw new InvalidDataException("ZIP 추가 영역이 잘렸습니다.");
                int size = U16(extra, at + 2);
                if (at + 4 + size > extra.Length) throw new InvalidDataException("ZIP 추가 영역 길이가 잘못됐습니다.");
                if (U16(extra, at) != 0x7075) output.Write(extra, at, 4 + size);
                at += 4 + size;
            }
            return output.ToArray();
        }
    }

    private static byte[] AddExtra(byte[] original, byte[] unicode)
    {
        byte[] clean = WithoutUnicodeExtra(original);
        byte[] result = new byte[clean.Length + unicode.Length];
        Buffer.BlockCopy(clean, 0, result, 0, clean.Length);
        Buffer.BlockCopy(unicode, 0, result, clean.Length, unicode.Length);
        if (result.Length > ushort.MaxValue) throw new InvalidDataException("ZIP 추가 영역이 너무 깁니다.");
        return result;
    }

    private static byte[] UnicodePath(byte[] alias, string original)
    {
        byte[] name = Utf8.GetBytes(original);
        uint crc = 0xffffffff;
        foreach (byte value in alias) {
            crc ^= value;
            for (int bit = 0; bit < 8; bit++) crc = (crc >> 1) ^ ((crc & 1) == 0 ? 0u : 0xedb88320u);
        }
        byte[] result = new byte[9 + name.Length];
        Put16(result, 0, 0x7075);
        Put16(result, 2, checked((ushort)(5 + name.Length)));
        result[4] = 1;
        Put32(result, 5, ~crc);
        Buffer.BlockCopy(name, 0, result, 9, name.Length);
        return result;
    }

    private static long FindDirectory(FileStream stream, BinaryReader reader, out byte[] ending)
    {
        long first = Math.Max(0, stream.Length - 22 - ushort.MaxValue);
        for (long at = stream.Length - 22; at >= first; at--) {
            stream.Position = at;
            if (reader.ReadUInt32() != 0x06054b50) continue;
            byte[] fixedPart = ReadBytes(reader, 18);
            int commentLength = U16(fixedPart, 16);
            if (at + 22 + commentLength != stream.Length) continue;
            ending = new byte[22 + commentLength];
            Put32(ending, 0, 0x06054b50);
            Buffer.BlockCopy(fixedPart, 0, ending, 4, 18);
            Buffer.BlockCopy(ReadBytes(reader, commentLength), 0, ending, 22, commentLength);
            if (U16(ending, 4) != 0 || U16(ending, 6) != 0 || U16(ending, 8) != U16(ending, 10)
                || U16(ending, 10) == ushort.MaxValue || U32(ending, 12) == uint.MaxValue
                || U32(ending, 16) == uint.MaxValue) throw new InvalidDataException("ZIP64 또는 여러 디스크 ZIP은 지원하지 않습니다.");
            return at;
        }
        throw new InvalidDataException("ZIP 중앙 디렉터리를 찾지 못했습니다.");
    }

    private static void CopyRange(FileStream input, FileStream output, long start, long length)
    {
        input.Position = start;
        byte[] buffer = new byte[1024 * 1024];
        while (length > 0) {
            int count = input.Read(buffer, 0, (int)Math.Min(buffer.Length, length));
            if (count == 0) throw new EndOfStreamException();
            output.Write(buffer, 0, count);
            length -= count;
        }
    }

    private static void NormalizeZip(string path)
    {
        string temporary = path + ".utf8-" + Guid.NewGuid().ToString("N");
        try {
            using (var input = File.OpenRead(path))
            using (var reader = new BinaryReader(input))
            using (var output = new FileStream(temporary, FileMode.CreateNew, FileAccess.Write)) {
                byte[] ending;
                long directoryEnd = FindDirectory(input, reader, out ending);
                long directoryStart = U32(ending, 16);
                if (directoryStart + U32(ending, 12) != directoryEnd) throw new InvalidDataException("ZIP 중앙 디렉터리 크기가 다릅니다.");
                input.Position = directoryStart;
                var entries = new List<Entry>();
                var aliases = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
                for (int i = 0; i < U16(ending, 10); i++) {
                    byte[] header = ReadBytes(reader, 46);
                    if (U32(header, 0) != 0x02014b50) throw new InvalidDataException("ZIP 중앙 항목이 아닙니다.");
                    var entry = new Entry { Header = header, Name = ReadBytes(reader, U16(header, 28)),
                        Extra = ReadBytes(reader, U16(header, 30)), Comment = ReadBytes(reader, U16(header, 32)), Offset = U32(header, 42) };
                    bool ascii = Array.TrueForAll(entry.Name, value => value < 128);
                    if (!ascii && (U16(header, 8) & 0x800) == 0) throw new InvalidDataException("UTF-8 표시가 없는 비 ASCII ZIP 이름입니다.");
                    string name = Utf8.GetString(entry.Name);
                    string alias = ascii ? name : String.Join("/", Array.ConvertAll(name.Split('/'), Uri.EscapeDataString));
                    entry.Alias = Encoding.ASCII.GetBytes(alias);
                    if (entry.Alias.Length > ushort.MaxValue || !aliases.Add(alias)) throw new InvalidDataException("ZIP 대체 이름이 중복되거나 너무 깁니다.");
                    entry.UnicodeExtra = ascii ? new byte[0] : UnicodePath(entry.Alias, name);
                    entries.Add(entry);
                }
                if (input.Position != directoryEnd) throw new InvalidDataException("ZIP 중앙 디렉터리 항목 수가 다릅니다.");
                entries.Sort((left, right) => left.Offset.CompareTo(right.Offset));
                if (entries.Count > 0 && entries[0].Offset != 0) throw new InvalidDataException("예상하지 못한 ZIP 앞부분이 있습니다.");
                for (int i = 0; i < entries.Count; i++) {
                    Entry entry = entries[i];
                    long next = i + 1 < entries.Count ? entries[i + 1].Offset : directoryStart;
                    input.Position = entry.Offset;
                    byte[] local = ReadBytes(reader, 30);
                    if (U32(local, 0) != 0x04034b50) throw new InvalidDataException("ZIP 로컬 항목이 아닙니다.");
                    byte[] localName = ReadBytes(reader, U16(local, 26));
                    byte[] localExtra = ReadBytes(reader, U16(local, 28));
                    if (!StructuralEquals(localName, entry.Name)) throw new InvalidDataException("ZIP 로컬 이름과 중앙 이름이 다릅니다.");
                    long dataStart = input.Position;
                    if (next < dataStart) throw new InvalidDataException("ZIP 로컬 항목 크기가 잘못됐습니다.");
                    byte[] newExtra = AddExtra(localExtra, entry.UnicodeExtra);
                    entry.NewOffset = output.Position;
                    Put16(local, 6, (ushort)(U16(local, 6) & ~0x800));
                    Put16(local, 26, checked((ushort)entry.Alias.Length));
                    Put16(local, 28, checked((ushort)newExtra.Length));
                    output.Write(local, 0, local.Length);
                    output.Write(entry.Alias, 0, entry.Alias.Length);
                    output.Write(newExtra, 0, newExtra.Length);
                    CopyRange(input, output, dataStart, next - dataStart);
                }
                long newDirectory = output.Position;
                foreach (Entry entry in entries) {
                    byte[] extra = AddExtra(entry.Extra, entry.UnicodeExtra);
                    Put16(entry.Header, 8, (ushort)(U16(entry.Header, 8) & ~0x800));
                    Put16(entry.Header, 28, checked((ushort)entry.Alias.Length));
                    Put16(entry.Header, 30, checked((ushort)extra.Length));
                    Put32(entry.Header, 42, checked((uint)entry.NewOffset));
                    output.Write(entry.Header, 0, entry.Header.Length);
                    output.Write(entry.Alias, 0, entry.Alias.Length);
                    output.Write(extra, 0, extra.Length);
                    output.Write(entry.Comment, 0, entry.Comment.Length);
                }
                Put32(ending, 12, checked((uint)(output.Position - newDirectory)));
                Put32(ending, 16, checked((uint)newDirectory));
                output.Write(ending, 0, ending.Length);
            }
            File.Replace(temporary, path, null);
        } finally {
            if (File.Exists(temporary)) File.Delete(temporary);
        }
    }

    private static bool StructuralEquals(byte[] left, byte[] right)
    {
        if (left.Length != right.Length) return false;
        for (int i = 0; i < left.Length; i++) if (left[i] != right[i]) return false;
        return true;
    }

    private static int Main(string[] args)
    {
        try {
            string vendor = Path.GetDirectoryName(Assembly.GetExecutingAssembly().Location);
            bool createZip = args.Length >= 2 && args[0] == "a" && Array.Exists(args, value => value == "-tzip");
            var command = new StringBuilder();
            foreach (string arg in args) command.Append(Quote(arg)).Append(' ');
            if (createZip) command.Append("-mcu=on");
            var start = new ProcessStartInfo(Path.Combine(vendor, "7z-x64.exe"), command.ToString()) {
                UseShellExecute = false, CreateNoWindow = true, WorkingDirectory = Environment.CurrentDirectory,
            };
            using (Process process = Process.Start(start)) {
                process.WaitForExit();
                if (process.ExitCode != 0) return process.ExitCode;
            }
            if (createZip) NormalizeZip(Path.GetFullPath(args[1]));
            return 0;
        } catch (Exception error) {
            Console.Error.WriteLine(error);
            return 1;
        }
    }
}
