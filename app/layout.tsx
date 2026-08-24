export const metadata = {
  title: "Song + Lyrics → LRC",
  description: "Synchronisiert vorhandene Lyrics mit einem fertigen Song und erzeugt LRC/SRT."
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="de">
      <body style={{margin:0,fontFamily:"Arial, Helvetica, sans-serif",background:"#111",color:"#eee"}}>
        {children}
      </body>
    </html>
  );
}
