import OpenAI from "openai";
const client = new OpenAI();

// Routes each inbound ticket to a queue.
export async function classifyTicket(subject: string, body: string) {
  const res = await client.chat.completions.create({
    model: "gpt-5.6",
    max_tokens: 20,
    messages: [
      { role: "system", content: "Classify the support ticket as one of: billing, bug, feature, other. Reply with the label only." },
      { role: "user", content: `${subject}\n${body}` },
    ],
  });
  return res.choices[0].message.content;
}
