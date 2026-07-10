from google import genai

client = genai.Client(api_key='AIzaSyCvg8n9PbJKoTjz0_c52ESuVPWJR9lvj0o')

response = client.models.generate_content(
    model='gemini-2.5-flash-lite',
    contents='把"Hello World"翻译成中文'
)
print(response.text)