import { Image, StyleSheet, View } from "react-native";
import appMark from "../assets/splash-icon.png";

const MARK = 56;
// The Quant mark fills 656 of the 1024 px splash icon, starting 184 px in from each edge.
const CROP = { x: 184, y: 184, size: 656 };
const SCALE = MARK / CROP.size;

export function AppMark() {
  return (
    <View
      accessible={false}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={styles.frame}
    >
      <Image source={appMark} style={styles.image} />
    </View>
  );
}

const styles = StyleSheet.create({
  frame: {
    width: MARK,
    height: MARK,
    overflow: "hidden",
    alignSelf: "center",
  },
  image: {
    position: "absolute",
    width: 1024 * SCALE,
    height: 1024 * SCALE,
    left: -CROP.x * SCALE,
    top: -CROP.y * SCALE,
  },
});
