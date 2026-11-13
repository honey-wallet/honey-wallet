import { createStore } from '@/lib/store';

/**
 * What the tab bar's full-width join button says while signed out. A screen can make it
 * name what signing in is for (the Following tab: "Sign in to follow"), and puts it back
 * when it's left.
 */
export const joinLabel = createStore('Sign in');
