// What the spotlight (VoiceStage) tells the player inside it: the YouTube overlay shows the pop-out
// and full screen buttons itself while the spotlight is full screen (the spotlight's own bar is
// hidden for it then), and asks for them with the 'mumh5-spot' event.
export const spotState = $state({ fullscreen: false, poppedOut: false });
export const spotAction = (action: 'fullscreen' | 'popout') =>
  window.dispatchEvent(new CustomEvent('mumh5-spot', { detail: action }));
