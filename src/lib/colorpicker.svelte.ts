// The app's own color picker (ui/ColorPicker.svelte), used everywhere a color is chosen. The picker
// the browser provides has an eyedropper that cannot be taken out; this one is picked and then Applied.
interface Request {
  initial: string;
  // Called while the color is being changed, before Apply (to show it live)
  onpreview?: (color: string) => void;
  resolve: (color: string | null) => void;
}

class ColorPickerStore {
  state = $state.raw<Request | null>(null);

  // The color chosen with Apply (as #rrggbb), or null when closed without applying
  open(initial: string, onpreview?: (color: string) => void): Promise<string | null> {
    this.state?.resolve(null);
    return new Promise(resolve => { this.state = { initial, onpreview, resolve }; });
  }

  close(color: string | null): void {
    const s = this.state;
    this.state = null;
    s?.resolve(color);
  }
}

export const colorPicker = new ColorPickerStore();
