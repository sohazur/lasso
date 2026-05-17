export default function CallDetail({ params }: { params: { id: string } }) {
  return (
    <main style={{ padding: 32, maxWidth: 800, margin: "0 auto" }}>
      <h1 style={{ fontSize: 22, fontWeight: 700, marginBottom: 8 }}>Call {params.id}</h1>
      <p style={{ color: "#999" }}>Transcript and timeline will render here.</p>
    </main>
  );
}
