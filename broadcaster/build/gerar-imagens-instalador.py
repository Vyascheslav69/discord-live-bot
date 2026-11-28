# Gera a logo do instalador (BMP sobre o fundo do tema; o NSIS não carrega PNG com transparência).
# Rode de novo se trocar build/icon.png:  python build/gerar-imagens-instalador.py
from pathlib import Path
from PIL import Image

here = Path(__file__).parent
bg = (0x12, 0x08, 0x1F)  # --plum do app
icon = Image.open(here / 'icon.png').convert('RGBA').resize((96, 96), Image.LANCZOS)
logo = Image.new('RGB', icon.size, bg)
logo.paste(icon, mask=icon)
logo.save(here / 'instalador-logo.bmp')
print('build/instalador-logo.bmp')
