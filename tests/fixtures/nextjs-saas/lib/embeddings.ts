import OpenAI from "openai";
const openai = new OpenAI();

export async function embedChunks(chunks: string[]) {
  return Promise.all(
    chunks.map(async (c) => {
      const r = await openai.embeddings.create({ model: "text-embedding-3-large", input: c });
      return r.data[0].embedding;
    })
  );
}
