import OpenAI from "openai";
const openai = new OpenAI();
declare function pickModel(task: string): string;

export async function run(task: string, prompt: string) {
  return openai.chat.completions.create({ model: pickModel(task), messages: [{ role: "user", content: prompt }] });
}
