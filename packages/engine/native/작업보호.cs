// Windows Job Object로 자신이 만든 검사 프로세스 트리를 소유하고 정리한다.
using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using Microsoft.Win32.SafeHandles;

internal static class OwnedJob
{
    private const uint CREATE_SUSPENDED = 0x00000004;
    private const uint CREATE_UNICODE_ENVIRONMENT = 0x00000400;
    private const uint STARTF_USESTDHANDLES = 0x00000100;
    private const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000;
    private const uint WAIT_OBJECT_0 = 0;
    private const uint WAIT_TIMEOUT = 258;
    private const uint HANDLE_FLAG_INHERIT = 1;
    private const uint GENERIC_READ = 0x80000000;
    private const uint FILE_SHARE_READ = 1;
    private const uint FILE_SHARE_WRITE = 2;
    private const uint OPEN_EXISTING = 3;
    private const int JobObjectBasicAccountingInformation = 1;
    private const int JobObjectExtendedLimitInformation = 9;
    private static volatile bool cancelRequested;
    private static bool outputFailed;

    [StructLayout(LayoutKind.Sequential)]
    private struct SECURITY_ATTRIBUTES { public int nLength; public IntPtr lpSecurityDescriptor; [MarshalAs(UnmanagedType.Bool)] public bool bInheritHandle; }
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct STARTUPINFO
    {
        public uint cb; public string lpReserved; public string lpDesktop; public string lpTitle;
        public uint dwX; public uint dwY; public uint dwXSize; public uint dwYSize;
        public uint dwXCountChars; public uint dwYCountChars; public uint dwFillAttribute;
        public uint dwFlags; public ushort wShowWindow; public ushort cbReserved2;
        public IntPtr lpReserved2; public IntPtr hStdInput; public IntPtr hStdOutput; public IntPtr hStdError;
    }
    [StructLayout(LayoutKind.Sequential)]
    private struct PROCESS_INFORMATION { public IntPtr hProcess; public IntPtr hThread; public uint dwProcessId; public uint dwThreadId; }
    [StructLayout(LayoutKind.Sequential)]
    private struct BASIC_LIMIT
    {
        public long PerProcessUserTimeLimit; public long PerJobUserTimeLimit; public uint LimitFlags;
        public UIntPtr MinimumWorkingSetSize; public UIntPtr MaximumWorkingSetSize;
        public uint ActiveProcessLimit; public UIntPtr Affinity; public uint PriorityClass; public uint SchedulingClass;
    }
    [StructLayout(LayoutKind.Sequential)]
    private struct IO_COUNTERS
    {
        public ulong ReadOperationCount; public ulong WriteOperationCount; public ulong OtherOperationCount;
        public ulong ReadTransferCount; public ulong WriteTransferCount; public ulong OtherTransferCount;
    }
    [StructLayout(LayoutKind.Sequential)]
    private struct EXTENDED_LIMIT
    {
        public BASIC_LIMIT BasicLimitInformation; public IO_COUNTERS IoInfo;
        public UIntPtr ProcessMemoryLimit; public UIntPtr JobMemoryLimit;
        public UIntPtr PeakProcessMemoryUsed; public UIntPtr PeakJobMemoryUsed;
    }
    [StructLayout(LayoutKind.Sequential)]
    private struct BASIC_ACCOUNTING
    {
        public long TotalUserTime; public long TotalKernelTime; public long ThisPeriodTotalUserTime;
        public long ThisPeriodTotalKernelTime; public uint TotalPageFaultCount;
        public uint TotalProcesses; public uint ActiveProcesses; public uint TotalTerminatedProcesses;
    }

    [DllImport("kernel32.dll", SetLastError = true)] private static extern IntPtr CreateJobObject(IntPtr attributes, string name);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool SetInformationJobObject(IntPtr job, int infoClass, ref EXTENDED_LIMIT info, int length);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool QueryInformationJobObject(IntPtr job, int infoClass, out BASIC_ACCOUNTING info, int length, IntPtr returned);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool TerminateJobObject(IntPtr job, uint exitCode);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool TerminateProcess(IntPtr process, uint exitCode);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern uint ResumeThread(IntPtr thread);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool GetExitCodeProcess(IntPtr process, out uint code);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool CloseHandle(IntPtr handle);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool CreatePipe(out IntPtr read, out IntPtr write, ref SECURITY_ATTRIBUTES attributes, uint size);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool SetHandleInformation(IntPtr handle, uint mask, uint flags);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern IntPtr GetStdHandle(int kind);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern IntPtr CreateFile(string name, uint access, uint share, ref SECURITY_ATTRIBUTES attributes, uint creation, uint flags, IntPtr template);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true, EntryPoint = "CreateProcessW")]
    private static extern bool CreateProcess(string application, StringBuilder command, IntPtr processAttributes,
        IntPtr threadAttributes, bool inheritHandles, uint flags, IntPtr environment, string directory,
        ref STARTUPINFO startup, out PROCESS_INFORMATION process);

    private static void Close(ref IntPtr handle)
    {
        if (handle != IntPtr.Zero && handle != new IntPtr(-1)) CloseHandle(handle);
        handle = IntPtr.Zero;
    }

    private static string Quote(string value)
    {
        var result = new StringBuilder("\"");
        int slashes = 0;
        foreach (char letter in value)
        {
            if (letter == '\\') { slashes++; continue; }
            if (letter == '"') { result.Append('\\', slashes * 2 + 1); result.Append('"'); slashes = 0; continue; }
            result.Append('\\', slashes); slashes = 0; result.Append(letter);
        }
        result.Append('\\', slashes * 2); result.Append('"');
        return result.ToString();
    }

    private static bool ActiveCount(IntPtr job, out uint count)
    {
        BASIC_ACCOUNTING info;
        bool ok = QueryInformationJobObject(job, JobObjectBasicAccountingInformation, out info,
            Marshal.SizeOf(typeof(BASIC_ACCOUNTING)), IntPtr.Zero);
        count = ok ? info.ActiveProcesses : uint.MaxValue;
        return ok;
    }

    private static bool WaitEmpty(IntPtr job, int waitMs)
    {
        DateTime until = DateTime.UtcNow.AddMilliseconds(waitMs);
        uint count;
        while (DateTime.UtcNow <= until)
        {
            if (!ActiveCount(job, out count)) return false;
            if (count == 0) return true;
            Thread.Sleep(20);
        }
        return ActiveCount(job, out count) && count == 0;
    }

    private static bool CleanJob(IntPtr job, int waitMs)
    {
        uint count;
        if (!ActiveCount(job, out count)) return false;
        if (count > 0 && !TerminateJobObject(job, 1)) return false;
        return WaitEmpty(job, waitMs);
    }

    private static void Pump(IntPtr pipe, Stream output)
    {
        try
        {
            using (var input = new FileStream(new SafeFileHandle(pipe, true), FileAccess.Read, 65536))
            {
                byte[] buffer = new byte[65536]; int length;
                while ((length = input.Read(buffer, 0, buffer.Length)) > 0)
                {
                    output.Write(buffer, 0, length); output.Flush();
                }
            }
        }
        catch { outputFailed = true; }
    }

    private static void Status(string path, string value)
    {
        File.WriteAllText(path, value, new UTF8Encoding(false));
    }

    private static int Main(string[] args)
    {
        if (args.Length < 6) return 233;
        string statusPath = args[0];
        IntPtr job = IntPtr.Zero, stdoutRead = IntPtr.Zero, stdoutWrite = IntPtr.Zero;
        IntPtr stderrRead = IntPtr.Zero, stderrWrite = IntPtr.Zero, nullInput = IntPtr.Zero, environment = IntPtr.Zero;
        PROCESS_INFORMATION process = new PROCESS_INFORMATION();
        bool processCreated = false;
        try
        {
            string application = args[1], directory = args[2];
            int waitMs = int.Parse(args[3]);
            int envCount = int.Parse(args[4]);
            int at = 5;
            var env = new System.Collections.Generic.SortedDictionary<string, string>(StringComparer.OrdinalIgnoreCase);
            for (int i = 0; i < envCount; i++) { env.Add(args[at++], args[at++]); }
            int argCount = int.Parse(args[at++]);
            if (at + argCount != args.Length) throw new ArgumentException();
            var command = new StringBuilder(Quote(application));
            for (int i = 0; i < argCount; i++) command.Append(' ').Append(Quote(args[at++]));
            var envBlock = new StringBuilder();
            foreach (var item in env) envBlock.Append(item.Key).Append('=').Append(item.Value).Append('\0');
            envBlock.Append('\0');
            if (env.Count == 0) envBlock.Append('\0');
            environment = Marshal.StringToHGlobalUni(envBlock.ToString());

            job = CreateJobObject(IntPtr.Zero, null);
            if (job == IntPtr.Zero) { Status(statusPath, "SPAWN:job"); return 230; }
            EXTENDED_LIMIT limit = new EXTENDED_LIMIT();
            limit.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            if (!SetInformationJobObject(job, JobObjectExtendedLimitInformation, ref limit, Marshal.SizeOf(typeof(EXTENDED_LIMIT))))
            { Status(statusPath, "SPAWN:limit"); return 230; }

            var security = new SECURITY_ATTRIBUTES { nLength = Marshal.SizeOf(typeof(SECURITY_ATTRIBUTES)), bInheritHandle = true };
            if (!SetHandleInformation(GetStdHandle(-10), HANDLE_FLAG_INHERIT, 0)
                || !SetHandleInformation(GetStdHandle(-11), HANDLE_FLAG_INHERIT, 0)
                || !SetHandleInformation(GetStdHandle(-12), HANDLE_FLAG_INHERIT, 0))
            { Status(statusPath, "SPAWN:inherit"); return 230; }
            if (!CreatePipe(out stdoutRead, out stdoutWrite, ref security, 0)
                || !CreatePipe(out stderrRead, out stderrWrite, ref security, 0)
                || !SetHandleInformation(stdoutRead, HANDLE_FLAG_INHERIT, 0)
                || !SetHandleInformation(stderrRead, HANDLE_FLAG_INHERIT, 0))
            { Status(statusPath, "SPAWN:pipe"); return 230; }
            nullInput = CreateFile("NUL", GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE,
                ref security, OPEN_EXISTING, 0, IntPtr.Zero);
            if (nullInput == new IntPtr(-1)) { Status(statusPath, "SPAWN:input"); return 230; }

            var startup = new STARTUPINFO { cb = (uint)Marshal.SizeOf(typeof(STARTUPINFO)),
                dwFlags = STARTF_USESTDHANDLES, hStdInput = nullInput,
                hStdOutput = stdoutWrite, hStdError = stderrWrite };
            if (!CreateProcess(application, command, IntPtr.Zero, IntPtr.Zero, true,
                CREATE_SUSPENDED | CREATE_UNICODE_ENVIRONMENT, environment, directory, ref startup, out process))
            { Status(statusPath, "SPAWN:process"); return 230; }
            processCreated = true;
            Close(ref stdoutWrite); Close(ref stderrWrite); Close(ref nullInput);
            if (!AssignProcessToJobObject(job, process.hProcess))
            {
                bool stopped = TerminateProcess(process.hProcess, 1)
                    && WaitForSingleObject(process.hProcess, (uint)waitMs) == WAIT_OBJECT_0;
                Status(statusPath, stopped && WaitEmpty(job, waitMs) ? "SPAWN:assign" : "UNKNOWN:assign");
                return stopped ? 230 : 232;
            }

            IntPtr ownedStdoutRead = stdoutRead, ownedStderrRead = stderrRead;
            Thread stdout = new Thread(() => Pump(ownedStdoutRead, Console.OpenStandardOutput()));
            Thread stderr = new Thread(() => Pump(ownedStderrRead, Console.OpenStandardError()));
            stdout.IsBackground = true; stderr.IsBackground = true;
            stdout.Start(); stderr.Start();
            stdoutRead = IntPtr.Zero; stderrRead = IntPtr.Zero;
            ThreadPool.QueueUserWorkItem(_ => {
                try { Console.OpenStandardInput().ReadByte(); cancelRequested = true; }
                catch { cancelRequested = true; }
            });
            if (ResumeThread(process.hThread) == uint.MaxValue)
            {
                bool cleaned = CleanJob(job, waitMs);
                Status(statusPath, cleaned ? "SPAWN:resume" : "UNKNOWN:resume");
                return cleaned ? 230 : 232;
            }
            bool targetExited = false;
            while (!cancelRequested)
            {
                uint wait = WaitForSingleObject(process.hProcess, 50);
                if (wait == WAIT_OBJECT_0) { targetExited = true; break; }
                if (wait != WAIT_TIMEOUT) break;
            }
            uint targetCode = 0;
            bool codeKnown = targetExited && GetExitCodeProcess(process.hProcess, out targetCode);
            bool clean = CleanJob(job, waitMs);
            stdout.Join(waitMs); stderr.Join(waitMs);
            if (!clean || stdout.IsAlive || stderr.IsAlive || outputFailed || (targetExited && !codeKnown))
            { Status(statusPath, "UNKNOWN:cleanup"); return 232; }
            if (!targetExited) { Status(statusPath, "CLEAN"); return 0; }
            Status(statusPath, "OK:" + targetCode.ToString());
            return unchecked((int)targetCode);
        }
        catch
        {
            bool clean = !processCreated || (job != IntPtr.Zero && CleanJob(job, 5000));
            try { Status(statusPath, clean ? "SPAWN:helper" : "UNKNOWN:helper"); } catch { }
            return clean ? 230 : 232;
        }
        finally
        {
            Close(ref process.hThread); Close(ref process.hProcess);
            Close(ref stdoutRead); Close(ref stdoutWrite); Close(ref stderrRead); Close(ref stderrWrite);
            Close(ref nullInput); Close(ref job);
            if (environment != IntPtr.Zero) Marshal.FreeHGlobal(environment);
        }
    }
}
