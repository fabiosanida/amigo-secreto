// Exemplo fornecido pelo usuário, salvo como referência para uso no servidor.
export async function sendEmail(to: string, subject: string, text: string) {
  const response = await fetch(`${process.env.NOTIFICATIONS_API_URL}/api/v1/emails`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.NOTIFICATIONS_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      to,
      subject,
      text,
      idempotencyKey: crypto.randomUUID(),
    }),
  });

  if (!response.ok) throw new Error("Falha ao enviar e-mail");
  return response.json();
}
