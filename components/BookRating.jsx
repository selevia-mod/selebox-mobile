import { StyleSheet, Text, View } from "react-native";
import Svg, { Defs, LinearGradient, Path, Stop } from "react-native-svg";
import useAppTheme from "../hooks/useAppTheme";

const BookRating = ({ rating = 4.5, color, size = 40, starSize = 18, spacing = 4 }) => {
  const { theme } = useAppTheme();
  const resolvedColor = color || theme.accentAmber;
  const height = size * 0.7;
  const width = size * 0.9;

  // Render each star with partial fill support
  const renderStar = (index) => {
    const starValue = index + 1;
    let fill = theme.surfaceStrong; // default gray for empty stars

    // Full star
    if (rating >= starValue) {
      fill = resolvedColor;
    }
    // Partial star
    else if (rating > index && rating < starValue) {
      const percent = (rating - index) * 100;
      return (
        <Svg key={index} width={starSize} height={starSize} viewBox="0 0 24 24" style={{ marginHorizontal: spacing / 2 }}>
          <Defs>
            <LinearGradient id={`grad-${index}`} x1="0" y1="0" x2="100%" y2="0">
              <Stop offset={`${percent}%`} stopColor={resolvedColor} />
              <Stop offset={`${percent}%`} stopColor={theme.surfaceStrong} />
            </LinearGradient>
          </Defs>
          <Path
            fill={`url(#grad-${index})`}
            d="M12 .587l3.668 7.431 8.2 1.193-5.934 5.782 
              1.402 8.175L12 18.896l-7.336 3.852 
              1.402-8.175L.132 9.211l8.2-1.193z"
          />
        </Svg>
      );
    }

    // Full or empty star
    return (
      <Svg key={index} width={starSize} height={starSize} viewBox="0 0 24 24" style={{ marginHorizontal: spacing / 2 }}>
        <Path
          fill={fill}
          d="M12 .587l3.668 7.431 8.2 1.193-5.934 5.782 
            1.402 8.175L12 18.896l-7.336 3.852 
            1.402-8.175L.132 9.211l8.2-1.193z"
        />
      </Svg>
    );
  };

  return (
    <View style={styles.wrapper}>
      {/* Tag */}
      <View style={[styles.tagContainer, { width: width * 1.1, height }]}>
        <Svg width="100%" height="100%" viewBox="0 0 90 70">
          <Path d="M0 0 H65 L90 35 L65 70 H0 Z" fill={resolvedColor} />
        </Svg>
        <Text style={[styles.text, { color: theme.textInverse }]}>{rating}</Text>
      </View>

      {/* Stars */}
      <View style={[styles.starContainer]}>{[...Array(5)].map((_, i) => renderStar(i))}</View>
    </View>
  );
};

const styles = StyleSheet.create({
  wrapper: {
    alignItems: "center",
    flexDirection: "row",
    justifyContent: "center",
  },
  tagContainer: {
    position: "relative",
    justifyContent: "center",
    alignItems: "center",
  },
  text: {
    position: "absolute",
    fontWeight: "bold",
    fontSize: 13,
    paddingRight: 5,
  },
  starContainer: {
    flexDirection: "row",
    justifyContent: "center",
  },
});

export default BookRating;
