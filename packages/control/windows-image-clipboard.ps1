$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type -ReferencedAssemblies System.Windows.Forms,System.Drawing -TypeDefinition @'
using System;
using System.IO;
using System.Drawing;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using System.Windows.Forms;

// Current-user, read-only clipboard listener. No files, history, host paths or UI.
public sealed class StarportImageClipboard : NativeWindow {
    [DllImport("user32.dll")] static extern bool AddClipboardFormatListener(IntPtr window);
    [DllImport("user32.dll")] static extern bool RemoveClipboardFormatListener(IntPtr window);
    [DllImport("user32.dll")] static extern uint GetClipboardSequenceNumber();
    const int MaxBytes=16*1024*1024, MaxPixels=32000000;
    readonly Stream output=Console.OpenStandardOutput();
    readonly System.Windows.Forms.Timer timer=new System.Windows.Forms.Timer();
    uint sequence; bool pending=true; string lastHash=null;
    void Header(string value) { byte[] b=Encoding.ASCII.GetBytes(value+"\n"); output.Write(b,0,b.Length); }
    void Poll(object sender, EventArgs args) {
        uint current=GetClipboardSequenceNumber();
        if(!pending && current==sequence) return;
        try {
            if(!Clipboard.ContainsImage()) {
                lastHash=null; sequence=current; pending=false;
                Header("{\"kind\":\"clear\",\"sequence\":"+current+"}"); output.Flush(); return;
            }
            using(Image source=Clipboard.GetImage()) {
                if(source==null) return;
                if(source.Width<1 || source.Height<1 || (long)source.Width*source.Height>MaxPixels) {
                    sequence=current; pending=false; Header("{\"kind\":\"unavailable\"}"); output.Flush(); return;
                }
                using(Bitmap bitmap=new Bitmap(source.Width,source.Height,PixelFormat.Format32bppArgb)) {
                    using(Graphics graphics=Graphics.FromImage(bitmap)) {
                        graphics.CompositingMode=System.Drawing.Drawing2D.CompositingMode.SourceCopy;
                        graphics.DrawImageUnscaled(source,0,0);
                    }
                    using(MemoryStream memory=new MemoryStream()) {
                        bitmap.Save(memory,ImageFormat.Png);
                        if(memory.Length>MaxBytes) { sequence=current; pending=false; Header("{\"kind\":\"unavailable\"}"); output.Flush(); return; }
                        byte[] png=memory.ToArray(); string hash;
                        using(SHA256 sha=SHA256.Create()) hash=Convert.ToBase64String(sha.ComputeHash(png));
                        if(GetClipboardSequenceNumber()!=current) return;
                        sequence=current; pending=false;
                        // WSLg may echo our X11 image to Windows. Stop that loop.
                        if(hash==lastHash) return;
                        lastHash=hash;
                        Header("{\"kind\":\"image\",\"sequence\":"+current+",\"bytes\":"+png.Length+"}");
                        output.Write(png,0,png.Length); output.Flush();
                    }
                }
            }
        } catch(ExternalException) { pending=true; }
          catch(IOException) { Application.ExitThread(); }
          catch(ArgumentException) { sequence=current; pending=false; }
    }
    protected override void WndProc(ref Message message) {
        if(message.Msg==0x031D) pending=true;
        base.WndProc(ref message);
    }
    public static void Run() {
        usingSession();
    }
    static void usingSession() {
        StarportImageClipboard listener=new StarportImageClipboard();
        listener.CreateHandle(new CreateParams { Parent=new IntPtr(-3), Caption="Starport image clipboard" });
        if(!AddClipboardFormatListener(listener.Handle)) throw new InvalidOperationException("clipboard_listener_unavailable");
        // The controller owns stdin; losing it ends the helper, including a crash.
        Thread parent=new Thread(delegate() { try { while(Console.OpenStandardInput().ReadByte()!=-1) {} } catch {} Environment.Exit(0); });
        parent.IsBackground=true; parent.Start();
        listener.timer.Interval=250; listener.timer.Tick+=listener.Poll; listener.timer.Start();
        listener.Header("{\"kind\":\"ready\"}"); listener.output.Flush();
        try { Application.Run(); }
        finally { listener.timer.Stop(); RemoveClipboardFormatListener(listener.Handle); listener.DestroyHandle(); }
    }
}
'@
[StarportImageClipboard]::Run()
