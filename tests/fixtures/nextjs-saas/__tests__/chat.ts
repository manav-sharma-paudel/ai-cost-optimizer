import OpenAI from "openai";
const c = new OpenAI();
c.chat.completions.create({ model: "gpt-5.5-pro", messages: [] });
