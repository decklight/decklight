// Default character art — SPEC §8. A stylized human bust with one mouth
// group per Rhubarb mouth shape (A–H, X = rest). The controller shows
// exactly one group at a time by setting data-viseme on the overlay; the
// runtime CSS maps [data-viseme="B"] → [data-mouth="B"] visibility.
//
// Custom art replaces this SVG (config.narration.character.svg) and only has
// to honor the same contract: a root <svg> containing a [data-mouth="…"]
// group per shape it supports (missing shapes simply never show — the rest
// pose X should always exist). Optional extras the CSS also animates:
// [data-eyelid] groups blink, [data-idle] gets a subtle sway.
//
// Clothing and the backdrop read theme tokens (--accent, --block-bg) so the
// character restyles with the deck; skin, hair and lips are fixed — they are
// a person, not a UI element.

export const VISEMES = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'X'];

const SKIN = '#edb58e';
const SKIN_SHADE = '#c98f6d';
const HAIR = '#43302a';
const LIP = '#b96b58';
const MOUTH = '#57262c';
const TEETH = '#f6f1ea';
const TONGUE = '#d17a70';

export const DEFAULT_CHARACTER_SVG = `<svg viewBox="0 0 240 240" role="img" aria-label="Narrator" xmlns="http://www.w3.org/2000/svg">
  <circle cx="120" cy="120" r="116" fill="var(--block-bg, rgba(128,128,128,.14))" stroke="var(--accent, #6b7f9e)" stroke-opacity=".35" stroke-width="2"/>
  <clipPath id="dlc-bust"><circle cx="120" cy="120" r="114"/></clipPath>
  <g clip-path="url(#dlc-bust)">
    <path d="M120 164 C 94 164 71 178 61 198 L 56 240 L 184 240 L 179 198 C 169 178 146 164 120 164 Z" fill="var(--accent, #4f6fae)"/>
    <path d="M106 142 L 106 176 C 106 185 134 185 134 176 L 134 142 Z" fill="${SKIN}"/>
    <path d="M106 142 L 106 156 C 114 162 126 162 134 156 L 134 142 Z" fill="${SKIN_SHADE}"/>
    <g data-idle>
      <circle cx="75" cy="98" r="9" fill="${SKIN}"/>
      <circle cx="165" cy="98" r="9" fill="${SKIN}"/>
      <path d="M120 38 C 91 38 76 62 76 93 C 76 123 96 149 120 149 C 144 149 164 123 164 93 C 164 62 149 38 120 38 Z" fill="${SKIN}"/>
      <path d="M120 28 C 87 28 69 51 72 90 C 80 60 96 50 120 50 C 144 50 160 60 168 90 C 171 51 153 28 120 28 Z" fill="${HAIR}"/>
      <path d="M92 84 Q 103 78 114 83" stroke="#4a352c" stroke-width="4" fill="none" stroke-linecap="round"/>
      <path d="M126 83 Q 137 78 148 84" stroke="#4a352c" stroke-width="4" fill="none" stroke-linecap="round"/>
      <ellipse cx="103" cy="97" rx="7" ry="5.5" fill="#fbf7f2"/>
      <circle cx="103" cy="97" r="3.2" fill="#5a4030"/>
      <circle cx="103" cy="97" r="1.5" fill="#241a14"/>
      <circle cx="104.3" cy="95.6" r=".8" fill="#fff"/>
      <ellipse cx="137" cy="97" rx="7" ry="5.5" fill="#fbf7f2"/>
      <circle cx="137" cy="97" r="3.2" fill="#5a4030"/>
      <circle cx="137" cy="97" r="1.5" fill="#241a14"/>
      <circle cx="138.3" cy="95.6" r=".8" fill="#fff"/>
      <g data-eyelid><rect x="95" y="90.5" width="16" height="12" rx="6" fill="${SKIN}"/></g>
      <g data-eyelid><rect x="129" y="90.5" width="16" height="12" rx="6" fill="${SKIN}"/></g>
      <path d="M120 101 L 117 115 Q 120 119 124 116" stroke="${SKIN_SHADE}" stroke-width="3" fill="none" stroke-linecap="round"/>
      <ellipse cx="96" cy="115" rx="6.5" ry="4" fill="#e59e7d" opacity=".4"/>
      <ellipse cx="144" cy="115" rx="6.5" ry="4" fill="#e59e7d" opacity=".4"/>
      <g data-mouth="X"><path d="M106 130 Q 120 136 134 130" stroke="${LIP}" stroke-width="4" fill="none" stroke-linecap="round"/></g>
      <g data-mouth="A"><path d="M105 130 Q 120 124 135 130 Q 120 137 105 130 Z" fill="${LIP}"/></g>
      <g data-mouth="B"><path d="M104 129 Q 120 122 136 129 Q 120 141 104 129 Z" fill="${MOUTH}"/><rect x="110" y="126" width="20" height="5" rx="2" fill="${TEETH}"/></g>
      <g data-mouth="C"><ellipse cx="120" cy="131" rx="13" ry="8.5" fill="${MOUTH}"/><rect x="109" y="124.5" width="22" height="4.5" rx="2" fill="${TEETH}"/></g>
      <g data-mouth="D"><ellipse cx="120" cy="132" rx="16" ry="12" fill="${MOUTH}"/><rect x="106" y="122" width="28" height="6" rx="2.5" fill="${TEETH}"/><ellipse cx="120" cy="140" rx="9" ry="4.5" fill="${TONGUE}"/></g>
      <g data-mouth="E"><ellipse cx="120" cy="131" rx="9" ry="7" fill="${MOUTH}" stroke="${LIP}" stroke-width="3"/></g>
      <g data-mouth="F"><ellipse cx="120" cy="131" rx="6" ry="5.5" fill="${MOUTH}" stroke="${LIP}" stroke-width="3.5"/></g>
      <g data-mouth="G"><path d="M105 128 Q 120 123 135 128 Q 120 134 105 128 Z" fill="${LIP}"/><rect x="110" y="127" width="20" height="5" rx="2" fill="${TEETH}"/><path d="M108 134 Q 120 139 132 134" stroke="${LIP}" stroke-width="3" fill="none" stroke-linecap="round"/></g>
      <g data-mouth="H"><ellipse cx="120" cy="131" rx="12" ry="9" fill="${MOUTH}"/><path d="M113 125 Q 120 122 127 125 Q 127 132 120 133 Q 113 132 113 125 Z" fill="${TONGUE}"/></g>
    </g>
  </g>
</svg>`;
