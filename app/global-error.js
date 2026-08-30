"use client";

export default function GlobalError({ error, retry }) {
  return (
    <html lang="en">
      <body
        style={{
          fontFamily: "system-ui, sans-serif",
          display: "flex",
          minHeight: "100vh",
          alignItems: "center",
          justifyContent: "center",
          flexDirection: "column",
          gap: "1rem",
          margin: 0,
          background: "#F4F5F9",
          color: "#1E293B",
        }}
      >
        <h2 style={{ color: "#1E293B" }}>Something went wrong.</h2>
        <p style={{ color: "#64748B" }}>
          {error?.message || "An unexpected error occurred."}
        </p>
        <button
          onClick={() => retry()}
          style={{
            background: "#FFD600",
            color: "#1E293B",
            border: "1px solid rgba(226,232,240,0.6)",
            padding: "0.75rem 1.5rem",
            borderRadius: "0.75rem",
            fontWeight: 700,
            cursor: "pointer",
            boxShadow: "0 10px 25px -5px rgba(0,0,0,0.05),0 8px 10px -6px rgba(0,0,0,0.01)",
            transition: "all 150ms ease-out",
          }}
          onMouseDown={(e) => (e.currentTarget.style.transform = "scale(0.97)")}
          onMouseUp={(e) => (e.currentTarget.style.transform = "scale(1)")}
        >
          Try again
        </button>
      </body>
    </html>
  );
}
