using System;
using System.Text;
using System.Runtime.InteropServices;
using System.Runtime.InteropServices.ComTypes;

// Use the Unicode Shell API explicitly; WScript shortcuts can use the ANSI
// code page and reject Chinese names on an English Windows installation.
// https://learn.microsoft.com/windows/win32/api/shobjidl_core/nn-shobjidl_core-ishelllinkw
[ComImport, Guid("00021401-0000-0000-C000-000000000046")]
class StarportShellLink {}

[ComImport, Guid("000214F9-0000-0000-C000-000000000046"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IStarportShellLinkW {
    void GetPath([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder value, int size, IntPtr data, uint flags);
    void GetIDList(out IntPtr value);
    void SetIDList(IntPtr value);
    void GetDescription([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder value, int size);
    void SetDescription([MarshalAs(UnmanagedType.LPWStr)] string value);
    void GetWorkingDirectory([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder value, int size);
    void SetWorkingDirectory([MarshalAs(UnmanagedType.LPWStr)] string value);
    void GetArguments([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder value, int size);
    void SetArguments([MarshalAs(UnmanagedType.LPWStr)] string value);
    void GetHotkey(out short value);
    void SetHotkey(short value);
    void GetShowCmd(out int value);
    void SetShowCmd(int value);
    void GetIconLocation([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder value, int size, out int index);
    void SetIconLocation([MarshalAs(UnmanagedType.LPWStr)] string value, int index);
    void SetRelativePath([MarshalAs(UnmanagedType.LPWStr)] string value, uint reserved);
    void Resolve(IntPtr window, uint flags);
    void SetPath([MarshalAs(UnmanagedType.LPWStr)] string value);
}

public static class StarportLink {
    public static void Save(string file, string target, string arguments, string directory) {
        object instance = new StarportShellLink();
        try {
            IStarportShellLinkW link = (IStarportShellLinkW)instance;
            link.SetPath(target); link.SetArguments(arguments);
            link.SetWorkingDirectory(directory); link.SetShowCmd(7);
            ((IPersistFile)instance).Save(file, true);
        } finally { Marshal.ReleaseComObject(instance); }
    }
    public static string[] Read(string file) {
        object instance = new StarportShellLink();
        try {
            ((IPersistFile)instance).Load(file, 0);
            IStarportShellLinkW link = (IStarportShellLinkW)instance;
            StringBuilder target = new StringBuilder(32768), arguments = new StringBuilder(32768);
            link.GetPath(target, target.Capacity, IntPtr.Zero, 4);
            link.GetArguments(arguments, arguments.Capacity);
            return new string[] { target.ToString(), arguments.ToString() };
        } finally { Marshal.ReleaseComObject(instance); }
    }
}
