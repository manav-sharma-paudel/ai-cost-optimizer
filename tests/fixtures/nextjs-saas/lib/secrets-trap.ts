import OpenAI from "openai";
const client = new OpenAI({ apiKey: "sk-proj-FAKEFAKEFAKEFAKEFAKEFAKEFAKE0123456789" });
export const ask = () => client.chat.completions.create({ model: "sk-proj-FAKEFAKEFAKEFAKEFAKEFAKEFAKE0123456789", messages: [] });
